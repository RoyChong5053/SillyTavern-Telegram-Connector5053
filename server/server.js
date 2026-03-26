// server.js
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Markdown到HTML转换工具
const { convertToTelegramHtml } = require('./markdownToHtml');

// 添加日志记录函数，带有时间戳
function logWithTimestamp(level, ...args) {
    const now = new Date();

    // 使用本地时区格式化时间
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    const prefix = `[${timestamp}]`;

    switch (level) {
        case 'error':
            console.error(prefix, ...args);
            break;
        case 'warn':
            console.warn(prefix, ...args);
            break;
        default:
            console.log(prefix, ...args);
    }
}

// 重启保护 - 防止循环重启
const RESTART_PROTECTION_FILE = path.join(__dirname, '.restart_protection');
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000; // 1分钟

// 输入中状态管理
const TYPING_INTERVAL_MS = 4000; // Telegram typing状态有效期为5秒，我们每4秒刷新一次
const TYPING_CLEANUP_INTERVAL_MS = 10000; // 10秒无活动自动清理typing状态

// 检查是否可能处于循环重启状态
function checkRestartProtection() {
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, 'utf8'));
            const now = Date.now();

            // 清理过期的重启记录
            data.restarts = data.restarts.filter(time => now - time < RESTART_WINDOW_MS);

            // 添加当前重启时间
            data.restarts.push(now);

            // 如果在时间窗口内重启次数过多，则退出
            if (data.restarts.length > MAX_RESTARTS) {
                logWithTimestamp('error', `检测到可能的循环重启！在${RESTART_WINDOW_MS / 1000}秒内重启了${data.restarts.length}次。`);
                logWithTimestamp('error', '为防止资源耗尽，服务器将退出。请手动检查并修复问题后再启动。');

                // 如果有通知chatId，尝试发送错误消息
                if (process.env.RESTART_NOTIFY_CHATID) {
                    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
                    if (!isNaN(chatId)) {
                        // 创建临时bot发送错误消息
                        try {
                            const tempBot = new TelegramBot(require('./config').telegramToken, { polling: false });
                            tempBot.sendMessage(chatId, '检测到循环重启！服务器已停止以防止资源耗尽。请手动检查问题。')
                                .finally(() => process.exit(1));
                        } catch (e) {
                            process.exit(1);
                        }
                        return; // 等待消息发送后退出
                    }
                }

                process.exit(1);
            }

            // 保存更新后的重启记录
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));
        } else {
            // 创建新的重启保护文件
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify({ restarts: [Date.now()] }));
        }
    } catch (error) {
        logWithTimestamp('error', '重启保护检查失败:', error);
        // 出错时继续执行，不要阻止服务器启动
    }
}

// 智能消息编辑辅助函数
function shouldTriggerEdit(oldText, newText) {
    if (!oldText || !newText) return true;
    
    // 如果文本完全相同，不需要编辑
    if (oldText === newText) return false;
    
    // 计算文本相似度
    const similarity = calculateTextSimilarity(oldText, newText);
    
    // 如果相似度很高（小改动），减少编辑频率
    if (similarity > 0.95) {
        // 小改动：只有当字符数变化超过一定阈值时才编辑
        const lengthDiff = Math.abs(newText.length - oldText.length);
        return lengthDiff > 5; // 至少5个字符的变化
    }
    
    // 中等或大幅变化：总是编辑
    return true;
}

function calculateTextSimilarity(text1, text2) {
    // 简单的文本相似度计算（基于最长公共子序列比例）
    const longer = text1.length > text2.length ? text1 : text2;
    const shorter = text1.length > text2.length ? text2 : text1;
    
    if (longer.length === 0) return 1.0;
    
    // 计算编辑距离（简化版）
    let commonChars = 0;
    for (let i = 0; i < Math.min(longer.length, shorter.length); i++) {
        if (longer[i] === shorter[i]) {
            commonChars++;
        }
    }
    
    return commonChars / longer.length;
}

function calculateEditDelay(textLength) {
    // 动态计算编辑延迟：文本越长，延迟越短（更快更新）
    if (textLength <= 50) return 3000; // 短文本：3秒延迟
    if (textLength <= 200) return 2000; // 中等文本：2秒延迟
    return 1000; // 长文本：1秒延迟（用户期望更快更新）
}

// 输入中状态管理函数
function startTyping(chatId) {
    const session = ongoingStreams.get(chatId);
    if (!session) return;
    
    // 清除现有的定时器
    if (session.typingTimer) {
        clearInterval(session.typingTimer);
    }
    
    // 立即发送一次输入中状态
    bot.sendChatAction(chatId, 'typing').catch(error =>
        logWithTimestamp('error', '发送"输入中"状态失败:', error));
    session.lastTypingTime = Date.now();
    
    // 设置定时器持续发送输入中状态
    session.typingTimer = setInterval(() => {
        // 检查会话是否还存在
        if (!ongoingStreams.has(chatId)) {
            clearInterval(session.typingTimer);
            return;
        }
        
        bot.sendChatAction(chatId, 'typing').catch(error =>
            logWithTimestamp('error', '发送"输入中"状态失败:', error));
        session.lastTypingTime = Date.now();
    }, TYPING_INTERVAL_MS);
}

function stopTyping(chatId) {
    const session = ongoingStreams.get(chatId);
    if (session && session.typingTimer) {
        clearInterval(session.typingTimer);
        session.typingTimer = null;
    }
}

// 检查是否应该发送特定类型的通知到Telegram（基于消息内容）
function shouldSendNotification(messageText) {
    // 基于消息内容判断通知类型
    if (messageText.includes('连接') || messageText.includes('断开') || messageText.includes('重连')) {
        return notificationSettings.enableConnectionNotifications;
    }
    if (messageText.includes('生成') || messageText.includes('思考') || messageText.includes('等待')) {
        return notificationSettings.enableGenerationNotifications;
    }
    if (messageText.includes('错误') || messageText.includes('失败') || messageText.includes('抱歉')) {
        return notificationSettings.enableErrorNotifications;
    }
    
    // 默认发送所有通知
    return true;
}

// 自动清理长时间无活动的输入中状态
setInterval(() => {
    const now = Date.now();
    for (const [chatId, session] of ongoingStreams.entries()) {
        if (session.typingTimer && now - session.lastTypingTime > TYPING_CLEANUP_INTERVAL_MS) {
            logWithTimestamp('warn', `自动清理ChatID ${chatId}的长时间无活动输入中状态`);
            stopTyping(chatId);
        }
    }
}, TYPING_CLEANUP_INTERVAL_MS);

// 启动时检查重启保护（仅在设置了重启标记时）
if (process.env.TELEGRAM_CLEAR_UPDATES === '1') {
    checkRestartProtection();
}

// 检查配置文件是否存在
const configPath = path.join(__dirname, './config.js');
if (!fs.existsSync(configPath)) {
    logWithTimestamp('error', '错误: 找不到配置文件 config.js！');
    logWithTimestamp('error', '请在server目录下复制 config.example.js 为 config.js，并设置您的Telegram Bot Token');
    process.exit(1); // 终止程序
}

const config = require('./config');

// --- 配置 ---
// 从配置文件中获取Telegram Bot Token和WebSocket端口
const token = config.telegramToken;
// WebSocket服务器端口
const wssPort = config.wssPort;

// 检查是否修改了默认token
if (token === 'TOKEN' || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    logWithTimestamp('error', '错误: 请先在config.js文件中设置你的Telegram Bot Token！');
    logWithTimestamp('error', '找到 telegramToken: \'YOUR_TELEGRAM_BOT_TOKEN_HERE\' 这一行并替换为你从BotFather获取的token');
    process.exit(1); // 终止程序
}

// 初始化Telegram Bot，但不立即启动轮询
const bot = new TelegramBot(token, { polling: false });
logWithTimestamp('log', '正在初始化Telegram Bot...');

// 手动清除所有未处理的消息，然后启动轮询
(async function clearAndStartPolling() {
    try {
        logWithTimestamp('log', '正在清除Telegram消息队列...');

        // 检查是否是重启，如果是则使用更彻底的清除方式
        const isRestart = process.env.TELEGRAM_CLEAR_UPDATES === '1';
        if (isRestart) {
            logWithTimestamp('log', '检测到重启标记，将执行更彻底的消息队列清理...');
            // 获取更新并丢弃所有消息
            let updates;
            let lastUpdateId = 0;

            // 循环获取所有更新直到没有更多更新
            do {
                updates = await bot.getUpdates({
                    offset: lastUpdateId,
                    limit: 100,
                    timeout: 0
                });

                if (updates && updates.length > 0) {
                    lastUpdateId = updates[updates.length - 1].update_id + 1;
                    logWithTimestamp('log', `清理了 ${updates.length} 条消息，当前offset: ${lastUpdateId}`);
                }
            } while (updates && updates.length > 0);

            // 清除环境变量
            delete process.env.TELEGRAM_CLEAR_UPDATES;
            logWithTimestamp('log', '消息队列清理完成');
        } else {
            // 普通启动时的清理
            const updates = await bot.getUpdates({ limit: 100, timeout: 0 });
            if (updates && updates.length > 0) {
                // 如果有更新，获取最后一个更新的ID并设置offset为它+1
                const lastUpdateId = updates[updates.length - 1].update_id;
                await bot.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
                logWithTimestamp('log', `已清除 ${updates.length} 条待处理消息`);
            } else {
                logWithTimestamp('log', '没有待处理消息需要清除');
            }
        }

        // 启动轮询
        bot.startPolling({
            restart: true,
            clean: true
        });
        logWithTimestamp('log', 'Telegram Bot轮询已启动');
    } catch (error) {
        logWithTimestamp('error', '清除消息队列或启动轮询时出错:', error);
        // 如果清除失败，仍然尝试启动轮询
        bot.startPolling({ restart: true, clean: true });
        logWithTimestamp('log', 'Telegram Bot轮询已启动（清除队列失败后）');
    }
})();

// 初始化WebSocket服务器
const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp('log', `WebSocket服务器正在监听端口 ${wssPort}...`);

let sillyTavernClient = null; // 用于存储连接的SillyTavern扩展客户端

// 用于存储正在进行的流式会话，调整会话结构，使用Promise来处理messageId
// 结构: { messagePromise: Promise<number> | null, lastText: String, timer: NodeJS.Timeout | null, isEditing: boolean, lastActivity: number }
const ongoingStreams = new Map();

// 通知设置 - 控制不同类型的通知是否发送到Telegram
const notificationSettings = {
    enableConnectionNotifications: true, // 连接状态通知
    enableGenerationNotifications: true, // 生成状态通知  
    enableErrorNotifications: true,      // 错误通知
};

// 定期清理过期的流式会话（防止状态残留）
function cleanupExpiredSessions() {
    const now = Date.now();
    const expiredThreshold = 5 * 60 * 1000; // 5分钟无活动视为过期
    
    for (const [chatId, session] of ongoingStreams.entries()) {
        if (now - session.lastActivity > expiredThreshold) {
            logWithTimestamp('log', `清理过期会话 ChatID ${chatId} (最后活动: ${new Date(session.lastActivity).toLocaleTimeString()})`);
            if (session.timer) {
                clearTimeout(session.timer);
            }
            ongoingStreams.delete(chatId);
        }
    }
}

// 每30秒清理一次过期会话
setInterval(cleanupExpiredSessions, 30000);

// 重载服务器函数
function reloadServer(chatId) {
    logWithTimestamp('log', '重载服务器端组件...');
    Object.keys(require.cache).forEach(function (key) {
        if (key.indexOf('node_modules') === -1) {
            delete require.cache[key];
        }
    });
    try {
        delete require.cache[require.resolve('./config.js')];
        const newConfig = require('./config.js');
        Object.assign(config, newConfig);
        logWithTimestamp('log', '配置文件已重新加载');
    } catch (error) {
        logWithTimestamp('error', '重新加载配置文件时出错:', error);
        if (chatId) bot.sendMessage(chatId, '重新加载配置文件时出错: ' + error.message);
        return;
    }
    logWithTimestamp('log', '服务器端组件已重载');
    if (chatId) bot.sendMessage(chatId, '服务器端组件已成功重载。');
}

// 重启服务器函数
function restartServer(chatId) {
    logWithTimestamp('log', '重启服务器端组件...');

    // 清理重启保护文件，防止误判为循环重启
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            logWithTimestamp('log', '已清理重启保护文件，防止循环重启误判');
        }
    } catch (error) {
        logWithTimestamp('error', '清理重启保护文件失败:', error);
        // 即使清理失败也继续重启过程
    }

    // 首先停止Telegram Bot轮询
    bot.stopPolling().then(() => {
        logWithTimestamp('log', 'Telegram Bot轮询已停止');

        // 然后关闭WebSocket服务器
        if (wss) {
            wss.close(() => {
                logWithTimestamp('log', 'WebSocket服务器已关闭，准备重启...');
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `重启服务器: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            // 如果没有WebSocket服务器，直接重启
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `重启服务器: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    }).catch(err => {
        logWithTimestamp('error', '停止Telegram Bot轮询时出错:', err);
        
        // 清理重启保护文件，防止误判为循环重启
        try {
            if (fs.existsSync(RESTART_PROTECTION_FILE)) {
                fs.unlinkSync(RESTART_PROTECTION_FILE);
                logWithTimestamp('log', '已清理重启保护文件，防止循环重启误判');
            }
        } catch (error) {
            logWithTimestamp('error', '清理重启保护文件失败:', error);
            // 即使清理失败也继续重启过程
        }
        
        // 即使出错也继续重启过程
        if (wss) {
            wss.close(() => {
                // 重启代码...
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `重启服务器: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            // 如果没有WebSocket服务器，直接重启
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `重启服务器: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    });
}

// 退出服务器函数
function exitServer() {
    logWithTimestamp('log', '正在关闭服务器...');
    const forceExitTimeout = setTimeout(() => {
        logWithTimestamp('error', '退出操作超时，强制退出进程');
        process.exit(1);
    }, 10000);
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            logWithTimestamp('log', '已清理重启保护文件');
        }
    } catch (error) {
        logWithTimestamp('error', '清理重启保护文件失败:', error);
    }
    const finalExit = () => {
        clearTimeout(forceExitTimeout);
        logWithTimestamp('log', '服务器端组件已成功关闭');
        process.exit(0);
    };
    if (wss) {
        wss.close(() => {
            logWithTimestamp('log', 'WebSocket服务器已关闭');
            bot.stopPolling().finally(finalExit);
        });
    } else {
        bot.stopPolling().finally(finalExit);
    }
}

function handleSystemCommand(command, chatId) {
    logWithTimestamp('log', `执行系统命令: ${command}`);

    // 处理 ping 命令 - 返回连接状态信息
    if (command === 'ping') {
        const bridgeStatus = 'Bridge状态：已连接 ✅';
        const stStatus = sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN ?
            'SillyTavern状态：已连接 ✅' :
            'SillyTavern状态：未连接 ❌';
        bot.sendMessage(chatId, `${bridgeStatus}\n${stStatus}`);
        return;
    }

    let responseMessage = '';
    switch (command) {
        case 'reload':
            responseMessage = '正在重载服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接重载服务器
                bot.sendMessage(chatId, responseMessage);
                reloadServer(chatId);
            }
            break;
        case 'restart':
            responseMessage = '正在重启服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接重启服务器
                bot.sendMessage(chatId, responseMessage);
                restartServer(chatId);
            }
            break;
        case 'exit':
            responseMessage = '正在关闭服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接退出服务器
                bot.sendMessage(chatId, responseMessage);
                exitServer();
            }
            break;
        case 'clearcache':
            responseMessage = '正在清理缓存状态...';
            // 清理所有缓存状态
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.send(JSON.stringify({ type: 'clear_all_cache' }));
            }
            break;
        default:
            logWithTimestamp('warn', `未知的系统命令: ${command}`);
            bot.sendMessage(chatId, `未知的系统命令: /${command}`);
            return;
    }

    // 只有在SillyTavern已连接的情况下，消息才会在上面的switch语句中发送
    // 所以这里只在SillyTavern已连接时发送响应消息
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        bot.sendMessage(chatId, responseMessage);
    }
}

// 处理Telegram命令
async function handleTelegramCommand(command, args, chatId) {
    logWithTimestamp('log', `处理Telegram命令: /${command} ${args.join(' ')}`);

    // 显示"输入中"状态
    bot.sendChatAction(chatId, 'typing').catch(error =>
        logWithTimestamp('error', '发送"输入中"状态失败:', error));

    // 默认回复
    let replyText = `未知命令: /${command}。 使用 /help 查看所有命令。`;

    // 特殊处理help命令，无论SillyTavern是否连接都可以显示
    if (command === 'help') {
        replyText = `SillyTavern Telegram Bridge 命令：\n\n`;
        replyText += `聊天管理\n`;
        replyText += `/new - 开始与当前角色的新聊天。\n`;
        replyText += `/listchats - 列出当前角色的所有已保存的聊天记录。\n`;
        replyText += `/switchchat <chat_name> - 加载特定的聊天记录。\n`;
        replyText += `/switchchat_<序号> - 通过序号加载聊天记录。\n\n`;
        replyText += `角色管理\n`;
        replyText += `/listchars - 列出所有可用角色。\n`;
        replyText += `/switchchar <char_name> - 切换到指定角色。\n`;
        replyText += `/switchchar_<序号> - 通过序号切换角色。\n\n`;
        replyText += `系统管理\n`;
        replyText += `/reload - 重载插件的服务器端组件并刷新ST网页。\n`;
        replyText += `/restart - 刷新ST网页并重启插件的服务器端组件。\n`;
        replyText += `/exit - 退出插件的服务器端组件。\n`;
        replyText += `/ping - 检查连接状态。\n`;
        replyText += `/clearcache - 清理缓存状态。\n\n`;
        replyText += `帮助\n`;
        replyText += `/help - 显示此帮助信息。`;

        // 帮助信息也使用HTML格式
        let messageText = replyText;
        let parseMode = undefined;
        
        if (config.messageFormat === 'html') {
            messageText = convertToTelegramHtml(replyText);
            parseMode = 'HTML';
        }
        
        // 发送帮助信息并返回
        bot.sendMessage(chatId, messageText, {
            parse_mode: parseMode
        }).catch(err => {
            logWithTimestamp('error', `发送命令回复失败: ${err.message}`);
        });
        return;
    }

    // 检查SillyTavern是否连接
    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        let messageText = 'SillyTavern未连接，无法执行角色和聊天相关命令。请先确保SillyTavern已打开并启用了Telegram扩展。';
        let parseMode = undefined;
        
        if (config.messageFormat === 'html') {
            messageText = convertToTelegramHtml(messageText);
            parseMode = 'HTML';
        }
        
        bot.sendMessage(chatId, messageText, {
            parse_mode: parseMode
        });
        return;
    }

    // 根据命令类型处理
    switch (command) {
        case 'new':
            // 发送命令到前端执行
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'new',
                chatId: chatId
            }));
            return; // 前端会发送响应，所以这里直接返回
        case 'listchars':
            // 发送命令到前端执行
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchars',
                chatId: chatId
            }));
            return;
        case 'switchchar':
            if (args.length === 0) {
                replyText = '请提供角色名称或序号。用法: /switchchar <角色名称> 或 /switchchar_数字';
            } else {
                // 清理缓存状态（角色切换时）
                sillyTavernClient.send(JSON.stringify({
                    type: 'clear_cache',
                    chatId: chatId
                }));
                
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchar',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
            break;
        case 'listchats':
            // 发送命令到前端执行
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchats',
                chatId: chatId
            }));
            return;
        case 'switchchat':
            if (args.length === 0) {
                replyText = '请提供聊天记录名称。用法： /switchchat <聊天记录名称>';
            } else {
                // 清理缓存状态（聊天切换时）
                sillyTavernClient.send(JSON.stringify({
                    type: 'clear_cache',
                    chatId: chatId
                }));
                
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchat',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
            break;
        default:
            // 处理特殊格式的命令，如 switchchar_1, switchchat_2 等
            const charMatch = command.match(/^switchchar_(\d+)$/);
            if (charMatch) {
                // 清理缓存状态（角色切换时）
                sillyTavernClient.send(JSON.stringify({
                    type: 'clear_cache',
                    chatId: chatId
                }));
                
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command, // 保持原始命令格式
                    chatId: chatId
                }));
                return;
            }

            const chatMatch = command.match(/^switchchat_(\d+)$/);
            if (chatMatch) {
                // 清理缓存状态（聊天切换时）
                sillyTavernClient.send(JSON.stringify({
                    type: 'clear_cache',
                    chatId: chatId
                }));
                
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command, // 保持原始命令格式
                    chatId: chatId
                }));
                return;
            }
    }

    // 命令回复也使用HTML格式
    let messageText = replyText;
    let parseMode = undefined;
    
    if (config.messageFormat === 'html') {
        messageText = convertToTelegramHtml(replyText);
        parseMode = 'HTML';
    }
    
    // 发送回复
    bot.sendMessage(chatId, messageText, {
        parse_mode: parseMode
    }).catch(err => {
        logWithTimestamp('error', `发送命令回复失败: ${err.message}`);
    });
}

// --- WebSocket服务器逻辑 ---
wss.on('connection', ws => {
    logWithTimestamp('log', 'SillyTavern扩展已连接！');
    sillyTavernClient = ws;

    // WebSocket心跳检测 - 每30秒发送一次ping，如果60秒内无响应则断开连接
    let heartbeatInterval;
    let isAlive = true;
    
    const heartbeat = () => {
        isAlive = false;
        ws.ping();
        // 设置超时检查
        setTimeout(() => {
            if (!isAlive) {
                logWithTimestamp('warn', 'WebSocket心跳超时，强制断开连接');
                ws.terminate();
            }
        }, 30000); // 30秒超时
    };
    
    // 启动心跳检测
    heartbeatInterval = setInterval(heartbeat, 30000); // 每30秒检测一次
    
    ws.on('pong', () => {
        isAlive = true;
        logWithTimestamp('log', 'WebSocket心跳响应正常');
    });

    ws.on('message', async (message) => { // 将整个回调设为async
        let data; // 在 try 块外部声明 data
        try {
            data = JSON.parse(message);

            // --- 处理流式文本块 ---
            if (data.type === 'stream_chunk' && data.chatId) {
                let session = ongoingStreams.get(data.chatId);

                // 1. 如果会话不存在，立即同步创建一个占位会话，创建会话和messagePromise
                if (!session) {
                    // 使用let声明，以便在Promise内部访问
                    let resolveMessagePromise;
                    const messagePromise = new Promise(resolve => {
                        resolveMessagePromise = resolve;
                    });

                    session = {
                        messagePromise: messagePromise,
                        lastText: data.text,
                        timer: null,
                        isEditing: false, // 新增状态锁
                        lastActivity: Date.now(), // 记录最后活动时间
                        typingTimer: null, // 输入中状态定时器
                        lastTypingTime: Date.now(), // 最后输入中状态更新时间
                    };
                    ongoingStreams.set(data.chatId, session);
                    
                    // 开始持续显示输入中状态
                    startTyping(data.chatId);

                    // 异步发送第一条消息并更新 session
                    bot.sendMessage(data.chatId, '正在思考...')
                        .then(sentMessage => {
                            // 当消息发送成功时，解析Promise并传入messageId
                            resolveMessagePromise(sentMessage.message_id);
                        }).catch(err => {
                            logWithTimestamp('error', '发送初始Telegram消息失败:', err);
                            stopTyping(data.chatId);
                            ongoingStreams.delete(data.chatId); // 出错时清理
                        });
                } else {
                    // 2. 如果会话存在，只更新最新文本
                    session.lastText = data.text;
                    session.lastActivity = Date.now(); // 更新最后活动时间
                }

                // 3. 尝试触发一次编辑（智能节流保护）
                // 确保 messageId 已经获取到，并且当前没有正在进行的编辑或定时器
                // 使用 await messagePromise 来确保messageId可用
                const messageId = await session.messagePromise;

                if (messageId && !session.isEditing && !session.timer) {
                    // 智能编辑决策：只有当文本有显著变化时才进行编辑
                    const shouldEdit = shouldTriggerEdit(session.lastText, data.text);
                    
                    if (shouldEdit) {
                        session.timer = setTimeout(async () => { // 定时器回调也设为async
                            const currentSession = ongoingStreams.get(data.chatId);
                            if (currentSession) {
                                const currentMessageId = await currentSession.messagePromise;
                                if (currentMessageId) {
                                    currentSession.isEditing = true;
                                    // 流式更新消息也使用HTML格式
                                    let messageText = currentSession.lastText;
                                    let parseMode = undefined;
                                    
                                    if (config.messageFormat === 'html') {
                                        messageText = convertToTelegramHtml(currentSession.lastText);
                                        parseMode = 'HTML';
                                    }
                                    
                                    bot.editMessageText(messageText, {
                                        chat_id: data.chatId,
                                        message_id: currentMessageId,
                                        parse_mode: parseMode
                                    }).catch(err => {
                                        if (!err.message.includes('message is not modified'))
                                            logWithTimestamp('error', '编辑Telegram消息失败:', err.message);
                                    }).finally(() => {
                                        if (ongoingStreams.has(data.chatId)) ongoingStreams.get(data.chatId).isEditing = false;
                                    });
                                }
                                currentSession.timer = null;
                            }
                        }, calculateEditDelay(data.text.length)); // 动态延迟基于文本长度
                    }
                }
                return;
            }

            // --- 处理流式结束信号 ---
            if (data.type === 'stream_end' && data.chatId) {
                const session = ongoingStreams.get(data.chatId);
                // 只有当存在会话时才处理，这表明确实是流式传输
                if (session) {
                    if (session.timer) {
                        clearTimeout(session.timer);
                    }
                    logWithTimestamp('log', `收到流式结束信号，等待最终渲染文本更新...`);
                    // 注意：我们不在这里清理会话，而是等待final_message_update
                }
                // 如果不存在会话但收到stream_end，这是一个异常情况
                // 可能是由于某些原因会话被提前清理了
                else {
                    logWithTimestamp('warn', `收到流式结束信号，但找不到对应的会话 ChatID ${data.chatId}`);
                    // 为安全起见，我们仍然发送消息，但这种情况不应该发生
                    let messageText = data.text || "消息生成完成";
                    let parseMode = undefined;
                    
                    if (config.messageFormat === 'html') {
                        messageText = convertToTelegramHtml(data.text || "消息生成完成");
                        parseMode = 'HTML';
                    }
                    
                    await bot.sendMessage(data.chatId, messageText, {
                        parse_mode: parseMode
                    }).catch(err => {
                        logWithTimestamp('error', '发送流式结束消息失败:', err.message);
                    });
                }
                return;
            }

            // --- 处理最终渲染后的消息更新 ---
            if (data.type === 'final_message_update' && data.chatId) {
                const session = ongoingStreams.get(data.chatId);

                // 如果会话存在，说明是流式传输的最终更新
                if (session) {
                    // 使用 await messagePromise
                    const messageId = await session.messagePromise;
                    if (messageId) {
                        logWithTimestamp('log', `收到流式最终渲染文本，更新消息 ${messageId}`);
                        
                        // 根据配置选择消息格式
                        let messageText = data.text;
                        let parseMode = undefined;
                        
                        if (config.messageFormat === 'html') {
                            messageText = convertToTelegramHtml(data.text);
                            parseMode = 'HTML';
                        }
                        
                        await bot.editMessageText(messageText, {
                            chat_id: data.chatId,
                            message_id: messageId,
                            parse_mode: parseMode
                        }).catch(err => {
                            if (!err.message.includes('message is not modified'))
                                logWithTimestamp('error', '编辑最终格式化Telegram消息失败:', err.message);
                        });
                        logWithTimestamp('log', `ChatID ${data.chatId} 的流式传输准最终更新已发送。`);
                    } else {
                        logWithTimestamp('warn', `收到final_message_update，但流式会话的messageId未能获取。`);
                    }
                    // 清理流式会话
                    stopTyping(data.chatId);
                    ongoingStreams.delete(data.chatId);
                    logWithTimestamp('log', `ChatID ${data.chatId} 的流式会话已完成并清理。`);
                }
                // 如果会话不存在，说明这是一个完整的非流式回复
                // 注意：这种情况不应该发生，因为我们已经在客户端修复了这个问题
                // 但为了健壮性，我们仍然保留这个处理
                else {
                    logWithTimestamp('log', `收到非流式完整回复，直接发送新消息到 ChatID ${data.chatId}`);
                    
                    // 根据配置选择消息格式
                    let messageText = data.text;
                    let parseMode = undefined;
                    
                    if (config.messageFormat === 'html') {
                        messageText = convertToTelegramHtml(data.text);
                        parseMode = 'HTML';
                    }
                    
                    await bot.sendMessage(data.chatId, messageText, {
                        parse_mode: parseMode
                    }).catch(err => {
                        logWithTimestamp('error', '发送非流式完整回复失败:', err.message);
                    });
                }
                return;
            }

            // --- 其他消息处理逻辑 ---
            if (data.type === 'error_message' && data.chatId) {
                logWithTimestamp('error', `收到SillyTavern的错误报告，将发送至Telegram用户 ${data.chatId}: ${data.text}`);
                
                // 错误消息也使用HTML格式（如果需要）
                let messageText = data.text;
                let parseMode = undefined;
                
                if (config.messageFormat === 'html') {
                    messageText = convertToTelegramHtml(data.text);
                    parseMode = 'HTML';
                }
                
                bot.sendMessage(data.chatId, messageText, {
                    parse_mode: parseMode
                });
            } else if (data.type === 'info_message' && data.chatId) {
                logWithTimestamp('log', `收到信息消息，发送至Telegram用户 ${data.chatId}: ${data.text}`);
                
                // 信息消息也使用HTML格式（如果需要）
                let messageText = data.text;
                let parseMode = undefined;
                
                if (config.messageFormat === 'html') {
                    messageText = convertToTelegramHtml(data.text);
                    parseMode = 'HTML';
                }
                
                // 检查是否应该发送通知（基于消息内容类型）
                const shouldSend = shouldSendNotification(data.text);
                if (shouldSend) {
                    bot.sendMessage(data.chatId, messageText, {
                        parse_mode: parseMode
                    });
                } else {
                    logWithTimestamp('log', '通知设置已禁用，跳过发送信息消息');
                }
            } else if (data.type === 'ai_reply' && data.chatId) {
                logWithTimestamp('log', `收到非流式AI回复，发送至Telegram用户 ${data.chatId}`);
                // 确保在发送消息前清理可能存在的流式会话
                if (ongoingStreams.has(data.chatId)) {
                    logWithTimestamp('log', `清理 ChatID ${data.chatId} 的流式会话，因为收到了非流式回复`);
                    stopTyping(data.chatId);
                    ongoingStreams.delete(data.chatId);
                }
                // 根据配置选择消息格式
                let messageText = data.text;
                let parseMode = undefined;
                
                if (config.messageFormat === 'html') {
                    messageText = convertToTelegramHtml(data.text);
                    parseMode = 'HTML';
                }
                
                // 发送非流式回复
                await bot.sendMessage(data.chatId, messageText, {
                    parse_mode: parseMode
                }).catch(err => {
                    logWithTimestamp('error', `发送非流式AI回复失败: ${err.message}`);
                });
            } else if (data.type === 'typing_action' && data.chatId) {
                logWithTimestamp('log', `显示"输入中"状态给Telegram用户 ${data.chatId}`);
                bot.sendChatAction(data.chatId, 'typing').catch(error =>
                    logWithTimestamp('error', '发送"输入中"状态失败:', error));
            } else if (data.type === 'command_executed') {
                // 处理前端命令执行结果
                logWithTimestamp('log', `命令 ${data.command} 执行完成，结果: ${data.success ? '成功' : '失败'}`);
                if (data.message) {
                    logWithTimestamp('log', `命令执行消息: ${data.message}`);
                }
            } else if (data.type === 'ai_image' && data.chatId) {
                // 处理AI返回的图片
                logWithTimestamp('log', `收到AI生成的图片，发送到Telegram用户 ${data.chatId}`);
                try {
                    const imageData = data.image; // 可以是 base64 data URL, URL, 或 Buffer
                    const caption = data.caption || '';
                    await sendImageToTelegram(data.chatId, imageData, caption);
                } catch (error) {
                    logWithTimestamp('error', `发送AI图片到Telegram失败:`, error.message);
                    // 发送错误消息到用户
                    bot.sendMessage(data.chatId, '抱歉，AI生成的图片发送失败。').catch(err => {});
                }
            } else if (data.type === 'user_image' && data.chatId) {
                // 处理用户发送的图片（已在服务器端处理，这里记录）
                logWithTimestamp('log', `收到用户图片 (chatId: ${data.chatId})，已转发到SillyTavern`);
            } else if (data.type === 'clear_cache' && data.chatId) {
                // 清理指定聊天ID的缓存状态
                logWithTimestamp('log', `清理ChatID ${data.chatId} 的缓存状态`);
                const session = ongoingStreams.get(data.chatId);
                if (session) {
                    // 清理定时器
                    if (session.timer) {
                        clearTimeout(session.timer);
                    }
                    // 从Map中删除会话
                    stopTyping(data.chatId);
                    ongoingStreams.delete(data.chatId);
                    logWithTimestamp('log', `ChatID ${data.chatId} 的流式会话已清理`);
                } else {
                    logWithTimestamp('log', `ChatID ${data.chatId} 没有活跃的流式会话`);
                }
            } else if (data.type === 'clear_all_cache') {
                // 清理所有缓存状态
                logWithTimestamp('log', '清理所有缓存状态');
                for (const [chatId, session] of ongoingStreams.entries()) {
                    if (session.timer) {
                        clearTimeout(session.timer);
                    }
                    stopTyping(chatId);
                    ongoingStreams.delete(chatId);
                }
                logWithTimestamp('log', `已清理 ${ongoingStreams.size} 个活跃会话`);
            } else if (data.type === 'update_settings') {
                // 处理前端发送的设置更新
                logWithTimestamp('log', '收到设置更新');
                if (data.enableWhitelist !== undefined) {
                    logWithTimestamp('log', `白名单启用状态: ${data.enableWhitelist}`);
                    // 这里可以存储设置到服务器配置或内存中
                }
                if (data.userWhitelist !== undefined) {
                    logWithTimestamp('log', `用户白名单: ${data.userWhitelist}`);
                    // 这里可以存储设置到服务器配置或内存中
                }
                if (data.enableConnectionNotifications !== undefined) {
                    logWithTimestamp('log', `连接状态通知: ${data.enableConnectionNotifications}`);
                    notificationSettings.enableConnectionNotifications = data.enableConnectionNotifications;
                }
                if (data.enableGenerationNotifications !== undefined) {
                    logWithTimestamp('log', `生成状态通知: ${data.enableGenerationNotifications}`);
                    notificationSettings.enableGenerationNotifications = data.enableGenerationNotifications;
                }
                if (data.enableErrorNotifications !== undefined) {
                    logWithTimestamp('log', `错误通知: ${data.enableErrorNotifications}`);
                    notificationSettings.enableErrorNotifications = data.enableErrorNotifications;
                }
            }
        } catch (error) {
            logWithTimestamp('error', '处理SillyTavern消息时出错:', error);
            // 确保即使在解析JSON失败时也能清理
            if (data && data.chatId) {
                stopTyping(data.chatId);
                ongoingStreams.delete(data.chatId);
            }
        }
    });

    ws.on('close', () => {
        logWithTimestamp('log', 'SillyTavern扩展已断开连接。');
        // 清理心跳检测定时器
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        if (ws.commandToExecuteOnClose) {
            const { command, chatId } = ws.commandToExecuteOnClose;
            logWithTimestamp('log', `客户端断开连接，现在执行预定命令: ${command}`);
            if (command === 'reload') reloadServer(chatId);
            if (command === 'restart') restartServer(chatId);
            if (command === 'exit') exitServer(chatId);
        }
        sillyTavernClient = null;
        ongoingStreams.clear();
    });

    ws.on('error', (error) => {
        logWithTimestamp('error', 'WebSocket发生错误:', error);
        // 清理心跳检测定时器
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        if (sillyTavernClient) {
            sillyTavernClient.commandToExecuteOnClose = null; // 清除标记，防止意外执行
        }
        sillyTavernClient = null;
        ongoingStreams.clear();
    });
});

// === 图片处理函数 ===

// 从Telegram下载文件（支持图片）
async function downloadTelegramFile(fileId, chatId) {
    try {
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        
        return new Promise((resolve, reject) => {
            const protocol = fileUrl.startsWith('https') ? https : http;
            protocol.get(fileUrl, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`下载失败，状态码: ${res.statusCode}`));
                    return;
                }
                
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    resolve({
                        buffer: buffer,
                        mimeType: res.headers['content-type'] || 'image/jpeg',
                        fileName: file.file_path.split('/').pop() || `telegram_image_${fileId}.jpg`
                    });
                });
            }).on('error', reject);
        });
    } catch (error) {
        logWithTimestamp('error', `下载Telegram文件失败 (chatId: ${chatId}):`, error.message);
        throw error;
    }
}

// 将图片转换为base64（用于发送到SillyTavern）
function bufferToBase64(buffer, mimeType) {
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
}

// 发送图片到Telegram
async function sendImageToTelegram(chatId, imageData, caption = '') {
    try {
        // imageData 可以是 base64 string, Buffer, 或 URL
        if (typeof imageData === 'string' && imageData.startsWith('data:')) {
            // base64 data URL - 需要转换
            const base64Data = imageData.split(',')[1];
            const buffer = Buffer.from(base64Data, 'base64');
            
            await bot.sendPhoto(chatId, buffer, {
                caption: caption,
                filename: 'image.jpg'
            });
        } else if (Buffer.isBuffer(imageData)) {
            await bot.sendPhoto(chatId, imageData, {
                caption: caption,
                filename: 'image.jpg'
            });
        } else if (typeof imageData === 'string' && imageData.startsWith('http')) {
            await bot.sendPhoto(chatId, imageData, { caption: caption });
        } else {
            throw new Error('不支持的图片数据格式');
        }
        logWithTimestamp('log', `图片已发送到Telegram用户 ${chatId}`);
    } catch (error) {
        logWithTimestamp('error', `发送图片到Telegram失败:`, error.message);
        throw error;
    }
}

// 检查是否需要发送重启完成通知
if (process.env.RESTART_NOTIFY_CHATID) {
    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
    if (!isNaN(chatId)) {
        setTimeout(() => {
            bot.sendMessage(chatId, '服务器端组件已成功重启并准备就绪')
                .catch(err => logWithTimestamp('error', '发送重启通知失败:', err))
                .finally(() => {
                    delete process.env.RESTART_NOTIFY_CHATID;
                });
        }, 2000);
    }
}

// 监听Telegram消息
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || 'N/A';
    
    // 检查是否是群聊消息且@了bot
    const isGroupChat = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const botUsername = config.botUsername || (await bot.getMe()).username;
    const text = msg.text || '';
    
    // 如果是群聊消息且没有@bot，则忽略
    if (isGroupChat && !text.includes(`@${botUsername}`)) {
        return;
    }

    // 检查白名单是否已配置且不为空
    if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        // 如果当前用户的ID不在白名单中
        if (!config.allowedUserIds.includes(userId)) {
            logWithTimestamp('log', `拒绝了来自非白名单用户的访问：\n  - User ID: ${userId}\n  - Username: @${username}\n  - Chat ID: ${chatId}\n  - Message: "${text || '[图片消息]'}"`);
            // 向该用户发送一条拒绝消息
            bot.sendMessage(chatId, '抱歉，您无权使用此机器人。').catch(err => {
                logWithTimestamp('error', `向 ${chatId} 发送拒绝消息失败:`, err.message);
            });
            // 终止后续处理
            return;
        }
    }

    // 处理图片消息
    if (msg.photo && msg.photo.length > 0) {
        if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
            try {
                logWithTimestamp('log', `从Telegram用户 ${chatId} 收到图片，正在下载...`);
                
                // 获取最大尺寸的图片（最后一个元素是最大尺寸）
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                const fileData = await downloadTelegramFile(fileId, chatId);
                const base64Image = bufferToBase64(fileData.buffer, fileData.mimeType);
                
                logWithTimestamp('log', `图片下载完成，大小: ${fileData.buffer.length} bytes，发送到SillyTavern...`);
                
                // 发送图片到SillyTavern
                sillyTavernClient.send(JSON.stringify({
                    type: 'user_image',
                    chatId: chatId,
                    image: base64Image,
                    caption: msg.caption || '',
                    mimeType: fileData.mimeType
                }));
                
                logWithTimestamp('log', `图片已发送到SillyTavern (chatId: ${chatId})`);
            } catch (error) {
                logWithTimestamp('error', `处理Telegram图片失败:`, error.message);
                bot.sendMessage(chatId, '抱歉，处理您的图片时出现了错误。').catch(err => {});
            }
        } else {
            logWithTimestamp('warn', '收到Telegram图片，但SillyTavern扩展未连接。');
            bot.sendMessage(chatId, '抱歉，我现在无法连接到SillyTavern。请确保SillyTavern已打开并启用了Telegram扩展。');
        }
        return;
    }

    // 移除文本消息中的@bot提及（如果是群聊）
    let processedText = text;
    if (isGroupChat && botUsername) {
        processedText = text.replace(new RegExp(`@${botUsername}\\s*`, 'g'), '').trim();
        
        // 如果处理后为空字符串，则忽略
        if (!processedText) {
            return;
        }
    }
    if (!processedText) return;

    if (processedText.startsWith('/')) {
        const parts = processedText.slice(1).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        // 系统命令由服务器直接处理
        if (['reload', 'restart', 'exit', 'ping', 'clearcache'].includes(command)) {
            handleSystemCommand(command, chatId);
            return;
        }

        // 其他命令也由服务器处理，但可能需要前端执行
        handleTelegramCommand(command, args, chatId);
        return;
    }

    // 处理普通文本消息
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        logWithTimestamp('log', `从Telegram用户 ${chatId} 收到消息: "${processedText}"`);
        const payload = JSON.stringify({ type: 'user_message', chatId, text: processedText });
        sillyTavernClient.send(payload);
    } else {
        logWithTimestamp('warn', '收到Telegram消息，但SillyTavern扩展未连接。');
        bot.sendMessage(chatId, '抱歉，我现在无法连接到SillyTavern。请确保SillyTavern已打开并启用了Telegram扩展。');
    }
});