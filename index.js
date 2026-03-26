// index.js

// 只解构 getContext() 返回的对象中确实存在的属性
const {
    extensionSettings,
    deleteLastMessage, // 导入删除最后一条消息的函数
    saveSettingsDebounced, // 导入保存设置的函数
} = SillyTavern.getContext();

// getContext 函数是全局 SillyTavern 对象的一部分，我们不需要从别处导入它
// 在需要时直接调用 SillyTavern.getContext() 即可

// 从 script.js 导入所有需要的公共API函数
import {
    eventSource,
    event_types,
    getPastCharacterChats,
    sendMessageAsUser,
    doNewChat,
    selectCharacterById,
    openCharacterChat,
    Generate,
    setExternalAbortController,
} from "../../../../script.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
    userWhitelist: '', // 逗号分隔的用户ID白名单，为空表示允许所有用户
    enableWhitelist: false, // 是否启用白名单功能
    enableConnectionNotifications: true, // 启用连接状态通知
    enableGenerationNotifications: true, // 启用生成状态通知
    enableErrorNotifications: true, // 启用错误通知
};

let ws = null; // WebSocket实例
let lastProcessedChatId = null; // 用于存储最后处理过的Telegram chatId

// 添加一个全局变量来跟踪当前是否处于流式模式
let isStreamingMode = false;
let lastStreamedText = '';

// 自动重连相关变量
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_BASE = 1000; // 1秒
const RECONNECT_DELAY_MAX = 30000; // 30秒
let reconnectTimer = null;

// --- 工具函数 ---
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `状态： ${message}`;
        statusEl.style.color = color;
    }
}

// 检查是否应该发送特定类型的通知到Telegram
function shouldSendNotification(notificationType) {
    const settings = getSettings();
    switch (notificationType) {
        case 'connection':
            return settings.enableConnectionNotifications !== false;
        case 'generation':
            return settings.enableGenerationNotifications !== false;
        case 'error':
            return settings.enableErrorNotifications !== false;
        default:
            return true; // 默认发送所有通知
    }
}

function reloadPage() {
    window.location.reload();
}

// 发送设置到服务器
function sendSettingsToServer() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const settings = getSettings();
        ws.send(JSON.stringify({
            type: 'update_settings',
            enableWhitelist: settings.enableWhitelist,
            userWhitelist: settings.userWhitelist,
            enableConnectionNotifications: settings.enableConnectionNotifications,
            enableGenerationNotifications: settings.enableGenerationNotifications,
            enableErrorNotifications: settings.enableErrorNotifications
        }));
        console.log('[Telegram Bridge] 设置已发送到服务器');
    }
}
// ---

// 连接到WebSocket服务器
function connect() {
    // 清除任何现有的重连定时器
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[Telegram Bridge] 已连接');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL 未设置！', 'red');
        return;
    }

    updateStatus('连接中...', 'orange');
    console.log(`[Telegram Bridge] 正在连接 ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('[Telegram Bridge] 连接成功！');
        updateStatus('已连接', 'green');
        // 重置重连计数器
        reconnectAttempts = 0;
        // 连接成功后立即发送当前设置到服务器
        sendSettingsToServer();
    };

    // 定义消息处理函数
    const messageHandler = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);

            // 检查是否正在生成中，如果是则拦截用户消息并发送提示
            if ((data.type === 'user_message' || data.type === 'user_image') && isStreamingMode) {
                console.log('[Telegram Bridge] 检测到正在生成中，拦截用户消息');
                if (ws && ws.readyState === WebSocket.OPEN && shouldSendNotification('generation')) {
                    ws.send(JSON.stringify({
                        type: 'info_message',
                        chatId: data.chatId,
                        text: '⚠️ AI正在生成回复中，请等待当前回复完成后再发送新消息。'
                    }));
                }
                return; // 直接返回，不处理这条消息
            }

            // --- 用户图片处理 ---
            if (data.type === 'user_image') {
                console.log('[Telegram Bridge] 收到用户图片，发送给AI...', data);
                
                // 存储当前处理的chatId
                lastProcessedChatId = data.chatId;
                
                // 标记为非流式模式
                isStreamingMode = false;
                
                // 1. 发送"输入中"状态
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }
                
                // 2. 将用户图片发送到SillyTavern
                // 注意：sendMessageAsUser 可能只支持文本，需要根据SillyTavern API调整
                try {
                    // 尝试使用带图片的参数调用
                    await sendMessageAsUser({
                        text: data.caption || '用户发送了一张图片',
                        image: data.image,
                        mimeType: data.mimeType
                    });
                } catch (error) {
                    console.error('[Telegram Bridge] 发送图片到SillyTavern失败:', error);
                    // 发送错误回服务器
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: '抱歉，处理您的图片时遇到了错误。'
                        }));
                    }
                    return;
                }
                
                // 3. 设置流式回调（与文本消息相同）
                const streamCallback = (cumulativeText) => {
                    isStreamingMode = true;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'stream_chunk',
                            chatId: data.chatId,
                            text: cumulativeText,
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                
                // 4. 定义清理函数
                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN && isStreamingMode) {
                        if (!data.error) {
                            ws.send(JSON.stringify({ type: 'stream_end', chatId: data.chatId }));
                        }
                    }
                };
                
                eventSource.once(event_types.GENERATION_ENDED, cleanup);
                eventSource.once(event_types.GENERATION_STOPPED, cleanup);
                
                // 5. 触发SillyTavern的生成流程
                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error("[Telegram Bridge] Generate() 错误:", error);
                    await deleteLastMessage();
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: `抱歉，AI生成回复时遇到错误。\n您的上一条消息已被撤回，请重试。\n\n错误: ${error.message}`
                        }));
                    }
                    data.error = true;
                    cleanup();
                }
                
                return;
            }

            // --- 用户消息处理 ---
            if (data.type === 'user_message') {
                console.log('[Telegram Bridge] 收到用户消息。', data);

                // 存储当前处理的chatId
                lastProcessedChatId = data.chatId;

                // 默认情况下，假设不是流式模式
                isStreamingMode = false;

                // 1. 立即向Telegram发送“输入中”状态（无论是否流式）
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                // 2. 将用户消息添加到SillyTavern
                await sendMessageAsUser(data.text);

                // 3. 设置流式传输的回调
                const streamCallback = (cumulativeText) => {
                    // 标记为流式模式
                    isStreamingMode = true;
                    // 将每个文本块通过WebSocket发送到服务端
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'stream_chunk',
                            chatId: data.chatId,
                            text: cumulativeText,
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

                // 4. 定义一个清理函数
                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN && isStreamingMode) {
                        // 仅在没有错误且确实处于流式模式时发送stream_end
                        if (!data.error) {
                            ws.send(JSON.stringify({ type: 'stream_end', chatId: data.chatId }));
                        }
                    }
                    // 注意：不在这里重置isStreamingMode，让handleFinalMessage函数来处理
                };

                // 5. 监听生成结束事件，确保无论成功与否都执行清理
                // 注意: 我们现在使用once来确保这个监听器只执行一次，避免干扰后续的全局监听器
                eventSource.once(event_types.GENERATION_ENDED, cleanup);
                // 添加对手动停止生成的处理
                eventSource.once(event_types.GENERATION_STOPPED, cleanup);

                // 6. 触发SillyTavern的生成流程，并用try...catch包裹
                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error("[Telegram Bridge] Generate() 错误:", error);

                    // a. 从SillyTavern聊天记录中删除导致错误的用户消息
                    await deleteLastMessage();
                    console.log('[Telegram Bridge] 已删除导致错误的用户消息。');

                    // b. 准备并发送错误信息到服务端
                    const errorMessage = `抱歉，AI生成回复时遇到错误。\n您的上一条消息已被撤回，请重试或发送不同内容。\n\n错误详情: ${error.message || '未知错误'}`;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: errorMessage,
                        }));
                    }

                    // c. 标记错误以便cleanup函数知道
                    data.error = true;
                    cleanup(); // 确保清理监听器
                }

                return;
            }

            // --- 系统命令处理 ---
            if (data.type === 'system_command') {
                console.log('[Telegram Bridge] 收到系统命令', data);
                if (data.command === 'reload_ui_only') {
                    console.log('[Telegram Bridge] 正在刷新UI...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            // --- 执行命令处理 ---
            if (data.type === 'execute_command') {
                console.log('[Telegram Bridge] 执行命令', data);

                // 显示“输入中”状态
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = '命令执行失败，请稍后重试。';

                // 直接调用全局的 SillyTavern.getContext()
                const context = SillyTavern.getContext();
                let commandSuccess = false;

                try {
                    switch (data.command) {
                        case 'new':
                            await doNewChat({ deleteCurrentChat: false });
                            replyText = '新的聊天已经开始。';
                            commandSuccess = true;
                            break;
                        case 'listchars': {
                            const characters = context.characters.slice(1);
                            if (characters.length > 0) {
                                replyText = '可用角色列表：\n\n';
                                characters.forEach((char, index) => {
                                    replyText += `${index + 1}. /switchchar_${index + 1} - ${char.name}\n`;
                                });
                                replyText += '\n使用 /switchchar_数字 或 /switchchar 角色名称 来切换角色';
                            } else {
                                replyText = '没有找到可用角色。';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchar': {
                            if (!data.args || data.args.length === 0) {
                                replyText = '请提供角色名称或序号。用法: /switchchar <角色名称> 或 /switchchar_数字';
                                break;
                            }
                            const targetName = data.args.join(' ');
                            const characters = context.characters;
                            const targetChar = characters.find(c => c.name === targetName);

                            if (targetChar) {
                                const charIndex = characters.indexOf(targetChar);
                                await selectCharacterById(charIndex);
                                replyText = `已成功切换到角色 "${targetName}"。`;
                                commandSuccess = true;
                            } else {
                                replyText = `角色 "${targetName}" 未找到。`;
                            }
                            break;
                        }
                        case 'listchats': {
                            if (context.characterId === undefined) {
                                replyText = '请先选择一个角色。';
                                break;
                            }
                            const chatFiles = await getPastCharacterChats(context.characterId);
                            if (chatFiles.length > 0) {
                                replyText = '当前角色的聊天记录：\n\n';
                                chatFiles.forEach((chat, index) => {
                                    const chatName = chat.file_name.replace('.jsonl', '');
                                    replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
                                });
                                replyText += '\n使用 /switchchat_数字 或 /switchchat 聊天名称 来切换聊天';
                            } else {
                                replyText = '当前角色没有任何聊天记录。';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchat': {
                            if (!data.args || data.args.length === 0) {
                                replyText = '请提供聊天记录名称。用法： /switchchat <聊天记录名称>';
                                break;
                            }
                            const targetChatFile = `${data.args.join(' ')}`;
                            try {
                                await openCharacterChat(targetChatFile);
                                replyText = `已加载聊天记录： ${targetChatFile}`;
                                commandSuccess = true;
                            } catch (err) {
                                console.error(err);
                                replyText = `加载聊天记录 "${targetChatFile}" 失败。请确认名称完全正确。`;
                            }
                            break;
                        }
                        default: {
                            // 处理特殊格式的命令，如 switchchar_1, switchchat_2 等
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const index = parseInt(charMatch[1]) - 1;
                                const characters = context.characters.slice(1);
                                if (index >= 0 && index < characters.length) {
                                    const targetChar = characters[index];
                                    const charIndex = context.characters.indexOf(targetChar);
                                    await selectCharacterById(charIndex);
                                    replyText = `已切换到角色 "${targetChar.name}"。`;
                                    commandSuccess = true;
                                } else {
                                    replyText = `无效的角色序号: ${index + 1}。请使用 /listchars 查看可用角色。`;
                                }
                                break;
                            }

                            const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                            if (chatMatch) {
                                if (context.characterId === undefined) {
                                    replyText = '请先选择一个角色。';
                                    break;
                                }
                                const index = parseInt(chatMatch[1]) - 1;
                                const chatFiles = await getPastCharacterChats(context.characterId);

                                if (index >= 0 && index < chatFiles.length) {
                                    const targetChat = chatFiles[index];
                                    const chatName = targetChat.file_name.replace('.jsonl', '');
                                    try {
                                        await openCharacterChat(chatName);
                                        replyText = `已加载聊天记录： ${chatName}`;
                                        commandSuccess = true;
                                    } catch (err) {
                                        console.error(err);
                                        replyText = `加载聊天记录失败。`;
                                    }
                                } else {
                                    replyText = `无效的聊天记录序号: ${index + 1}。请使用 /listchats 查看可用聊天记录。`;
                                }
                                break;
                            }

                            replyText = `未知命令: /${data.command}。使用 /help 查看所有命令。`;
                        }
                    }
                } catch (error) {
                    console.error('[Telegram Bridge] 执行命令时出错:', error);
                    replyText = `执行命令时出错: ${error.message || '未知错误'}`;
                }

                // 发送命令执行结果
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // 发送命令执行结果到Telegram
                    ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: replyText }));

                    // 发送命令执行状态反馈到服务器
                    ws.send(JSON.stringify({
                        type: 'command_executed',
                        command: data.command,
                        success: commandSuccess,
                        message: replyText
                    }));
                }

                return;
            }
        } catch (error) {
            console.error('[Telegram Bridge] 处理请求时发生错误：', error);
            if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error_message', chatId: data.chatId, text: '处理您的请求时发生了一个内部错误。' }));
            }
        }
    };

    // 设置WebSocket消息处理器（包含心跳响应）
    ws.onmessage = (event) => {
        // 检查是否是ping消息（二进制ping帧）
        if (event.data instanceof ArrayBuffer && event.data.byteLength === 0) {
            // 这是ping帧，自动响应pong
            console.log('[Telegram Bridge] 收到心跳ping，已自动响应');
            return;
        }
        
        // 正常消息交给消息处理器
        messageHandler(event);
    };

    ws.onclose = (event) => {
        console.log('[Telegram Bridge] 连接已关闭。', event.code, event.reason);
        updateStatus('连接已断开', 'red');
        ws = null;
        
        // 如果不是正常关闭，则尝试自动重连
        if (event.code !== 1000 && event.code !== 1001) { // 1000=正常关闭, 1001=离开
            scheduleReconnect();
        }
    };

    ws.onerror = (error) => {
        console.error('[Telegram Bridge] WebSocket 错误：', error);
        updateStatus('连接错误', 'red');
        ws = null;
        
        // WebSocket错误时也尝试重连
        scheduleReconnect();
    };
}

function disconnect() {
    if (ws) {
        ws.close();
    }
    // 清除重连定时器
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempts = 0;
}

// 自动重连调度函数
function scheduleReconnect() {
    const settings = getSettings();
    if (!settings.autoConnect) {
        console.log('[Telegram Bridge] 自动连接已禁用，不进行重连');
        return;
    }
    
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('[Telegram Bridge] 已达到最大重连尝试次数，停止重连');
        updateStatus('重连失败', 'red');
        return;
    }
    
    reconnectAttempts++;
    
    // 指数退避算法计算重连延迟
    const delay = Math.min(
        RECONNECT_DELAY_BASE * Math.pow(2, reconnectAttempts - 1),
        RECONNECT_DELAY_MAX
    );
    
    console.log(`[Telegram Bridge] 将在 ${delay}ms 后尝试第 ${reconnectAttempts} 次重连`);
    updateStatus(`重连中 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, 'orange');
    
    reconnectTimer = setTimeout(() => {
        console.log('[Telegram Bridge] 尝试自动重连...');
        connect();
    }, delay);
}

// 扩展加载时执行的函数
jQuery(async () => {
    console.log('[Telegram Bridge] 正在尝试加载设置 UI...');
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('[Telegram Bridge] 设置 UI 应该已经被添加。');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);
        $('#telegram_enable_whitelist').prop('checked', settings.enableWhitelist);
        $('#telegram_user_whitelist').val(settings.userWhitelist);
        $('#telegram_enable_connection_notifications').prop('checked', settings.enableConnectionNotifications);
        $('#telegram_enable_generation_notifications').prop('checked', settings.enableGenerationNotifications);
        $('#telegram_enable_error_notifications').prop('checked', settings.enableErrorNotifications);

        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            // 确保调用saveSettingsDebounced保存设置
            saveSettingsDebounced();
        });

        $('#telegram_auto_connect').on('change', function () {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            // 确保调用saveSettingsDebounced保存设置
            console.log(`[Telegram Bridge] 自动连接设置已更改为: ${settings.autoConnect}`);
            saveSettingsDebounced();
        });

        $('#telegram_enable_whitelist').on('change', function () {
            const settings = getSettings();
            settings.enableWhitelist = $(this).prop('checked');
            // 确保调用saveSettingsDebounced保存设置
            console.log(`[Telegram Bridge] 白名单启用设置已更改为: ${settings.enableWhitelist}`);
            saveSettingsDebounced();
            sendSettingsToServer(); // 立即发送到服务器
        });

        $('#telegram_user_whitelist').on('input', () => {
            const settings = getSettings();
            settings.userWhitelist = $('#telegram_user_whitelist').val();
            // 确保调用saveSettingsDebounced保存设置
            saveSettingsDebounced();
            sendSettingsToServer(); // 立即发送到服务器
        });

        // 连接状态通知设置
        $('#telegram_enable_connection_notifications').on('change', function () {
            const settings = getSettings();
            settings.enableConnectionNotifications = $(this).prop('checked');
            console.log(`[Telegram Bridge] 连接状态通知设置已更改为: ${settings.enableConnectionNotifications}`);
            saveSettingsDebounced();
            sendSettingsToServer(); // 立即发送到服务器
        });

        // 生成状态通知设置
        $('#telegram_enable_generation_notifications').on('change', function () {
            const settings = getSettings();
            settings.enableGenerationNotifications = $(this).prop('checked');
            console.log(`[Telegram Bridge] 生成状态通知设置已更改为: ${settings.enableGenerationNotifications}`);
            saveSettingsDebounced();
            sendSettingsToServer(); // 立即发送到服务器
        });

        // 错误通知设置
        $('#telegram_enable_error_notifications').on('change', function () {
            const settings = getSettings();
            settings.enableErrorNotifications = $(this).prop('checked');
            console.log(`[Telegram Bridge] 错误通知设置已更改为: ${settings.enableErrorNotifications}`);
            saveSettingsDebounced();
            sendSettingsToServer(); // 立即发送到服务器
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settings.autoConnect) {
            console.log('[Telegram Bridge] 自动连接已启用，正在连接...');
            connect();
        }

    } catch (error) {
        console.error('[Telegram Bridge] 加载设置 HTML 失败。', error);
    }
    console.log('[Telegram Bridge] 扩展已加载。');
});

// 全局事件监听器，用于最终消息更新
function handleFinalMessage(lastMessageIdInChatArray) {
    // 确保WebSocket已连接，并且我们有一个有效的chatId来发送更新
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    // 使用MutationObserver等待DOM更新完成，避免硬编码延迟
    observeDOMForMessageUpdate(lastMessageIndex);
}

// 使用MutationObserver观察DOM更新，替代硬编码setTimeout
function observeDOMForMessageUpdate(messageIndex) {
    const targetSelector = `#chat .mes[mesid="${messageIndex}"]`;
    const messageElement = $(targetSelector);
    
    if (messageElement.length > 0) {
        // 元素已存在，立即处理
        processMessageElement(messageElement, messageIndex);
        return;
    }

    // 元素不存在，设置MutationObserver等待DOM更新
    const observer = new MutationObserver((mutations, obs) => {
        const element = $(targetSelector);
        if (element.length > 0) {
            obs.disconnect();
            processMessageElement(element, messageIndex);
        }
    });

    // 观察整个chat容器
    observer.observe(document.getElementById('chat') || document.body, {
        childList: true,
        subtree: true,
        attributes: false,
        characterData: false
    });

    // 设置超时作为fallback（10秒，比原来的500ms更保守）
    setTimeout(() => {
        observer.disconnect();
        const element = $(targetSelector);
        if (element.length > 0) {
            processMessageElement(element, messageIndex);
        } else {
            console.log('[Telegram Bridge] 超时: 无法找到消息元素 mesid="' + messageIndex + '"');
            lastProcessedChatId = null;
        }
    }, 10000);
}

// 处理消息元素的通用函数
function processMessageElement(messageElement, messageIndex) {
    // 直接调用全局的 SillyTavern.getContext()
    const context = SillyTavern.getContext();
    const lastMessage = context.chat[messageIndex];

    // 确认这是我们刚刚通过Telegram触发的AI回复
    if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
        // === 新增：检查是否为图片消息 ===
        // SillyTavern 图片消息通常包含 image_url 或 image_base64 字段
        if (lastMessage.image_url || lastMessage.image_base64 || lastMessage.image) {
            console.log('[Telegram Bridge] 检测到图片回复，跳过文本处理（图片已通过单独事件发送）');
            lastProcessedChatId = null;
            return;
        }
        // === 结束新增 ===
        
        // 获取消息文本元素
        const messageTextElement = messageElement.find('.mes_text');

        if (messageTextElement.length > 0) {
            // 获取HTML内容并替换<br>和</p><p>为换行符
            let renderedText = messageTextElement.html()
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>\s*<p>/gi, '\n\n');

            // 解码HTML实体
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = renderedText;
            renderedText = tempDiv.textContent;

            console.log(`[Telegram Bridge] 捕获到最终渲染文本，准备发送更新到 chatId: ${lastProcessedChatId}`);

            // 判断是流式还是非流式响应
            if (isStreamingMode) {
                // 流式响应 - 发送final_message_update
                ws.send(JSON.stringify({
                    type: 'final_message_update',
                    chatId: lastProcessedChatId,
                    text: renderedText,
                }));
                isStreamingMode = false;
            } else {
                // 非流式响应 - 直接发送ai_reply
                ws.send(JSON.stringify({
                    type: 'ai_reply',
                    chatId: lastProcessedChatId,
                    text: renderedText,
                }));
            }

            // 重置chatId，避免意外更新其他用户的消息
            lastProcessedChatId = null;
        } else {
            console.log('[Telegram Bridge] 警告: 消息元素缺少 .mes_text 内容');
            lastProcessedChatId = null;
        }
    } else {
        console.log('[Telegram Bridge] 警告: 上下文消息不匹配或不是AI回复');
        lastProcessedChatId = null;
    }
}
// 全局事件监听器，用于最终消息更新
eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);

// 添加对手动停止生成的处理
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);

// === 图片支持 ===
// 监听 AI 生成图片的事件
const imageEventHandler = async (imageData) => {
    console.log('[Telegram Bridge] 检测到AI生成图片:', imageData);
    
    if (ws && ws.readyState === WebSocket.OPEN && lastProcessedChatId) {
        try {
            // 提取图片数据（根据 SillyTavern 的实际数据结构）
            const imagePayload = {
                type: 'ai_image',
                chatId: lastProcessedChatId,
                image: imageData.url || imageData.base64 || imageData,
                caption: imageData.caption || imageData.description || ''
            };
            
            ws.send(JSON.stringify(imagePayload));
            console.log('[Telegram Bridge] 图片已发送到Telegram服务器');
        } catch (error) {
            console.error('[Telegram Bridge] 发送图片失败:', error);
        }
    }
};

// 尝试添加图片事件监听（支持多种事件名称）
if (event_types.IMAGE_GENERATED) {
    eventSource.on(event_types.IMAGE_GENERATED, imageEventHandler);
    console.log('[Telegram Bridge] 已注册图片事件监听:', event_types.IMAGE_GENERATED);
} else if (event_types.IMAGE_CREATED) {
    eventSource.on(event_types.IMAGE_CREATED, imageEventHandler);
    console.log('[Telegram Bridge] 已注册图片事件监听:', event_types.IMAGE_CREATED);
} else {
    // 备用：监听字符串事件名
    eventSource.on('image_generated', imageEventHandler);
    console.log('[Telegram Bridge] 已注册备用图片事件监听: image_generated');
}