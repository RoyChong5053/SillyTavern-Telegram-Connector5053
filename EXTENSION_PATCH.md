# 扩展端代码修改补丁

本文档提供具体的代码修改步骤，让你的 SillyTavern 扩展支持图片。

## 前置准备

1. 找到扩展的 `index.js` 文件（位于 SillyTavern 的 `scripts/extensions/third-party/SillyTavern-Telegram-Connector/` 目录）
2. 备份原文件
3. 按照以下步骤修改

---

## 修改步骤

### 步骤 1: 添加图片事件监听

在 `index.js` 中找到这段代码：

```javascript
// 全局事件监听器，用于最终消息更新
eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);

// 添加对手动停止生成的处理
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);
```

**在这之后** 添加图片事件监听：

```javascript
// === 图片支持 ===
// 监听 AI 生成图片的事件
eventSource.on(event_types.IMAGE_GENERATED || 'image_generated', async (imageData) => {
    console.log('[Telegram Bridge] 检测到AI生成图片:', imageData);
    
    if (ws && ws.readyState === WebSocket.OPEN && lastProcessedChatId) {
        try {
            // 根据 SillyTavern 实际数据结构调整
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
});
```

**说明**: 如果 `event_types.IMAGE_GENERATED` 不存在，请使用字符串 `'image_generated'` 或查看 SillyTavern 源码找到正确的事件类型。

---

### 步骤 2: 修改消息处理，支持接收用户图片

在 `ws.onmessage` 函数中，找到处理 `user_message` 的地方（大约第 88 行）：

```javascript
// --- 用户消息处理 ---
if (data.type === 'user_message') {
    console.log('[Telegram Bridge] 收到用户消息。', data);
    
    // 存储当前处理的chatId
    lastProcessedChatId = data.chatId;
    
    // ... 后续代码
}
```

**在这个 if 语句之前** 添加新的消息类型处理：

```javascript
// --- 用户图片处理 ---
if (data.type === 'user_image') {
    console.log('[Telegram Bridge] 收到用户图片，发送给AI...', data);
    
    // 存储当前处理的chatId
    lastProcessedChatId = data.chatId;
    
    // 标记为流式模式
    isStreamingMode = false;
    
    // 1. 发送"输入中"状态
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
    }
    
    // 2. 发送图片到 SillyTavern
    // 注意: sendMessageAsUser 可能不支持直接传图片对象
    // 你可能需要使用其他 API 方法，见下面的"替代方案"
    try {
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
```

---

### 步骤 3: 修改 `handleFinalMessage` 函数，避免图片触发文本处理

找到 `handleFinalMessage` 函数（大约第 405 行），在函数开头添加：

```javascript
function handleFinalMessage(lastMessageIdInChatArray) {
    // 确保WebSocket已连接，并且我们有一个有效的chatId来发送更新
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    // 延迟以确保DOM更新完成
    setTimeout(() => {
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        // 确认这是我们刚刚通过Telegram触发的AI回复
        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            // === 新增：检查是否为图片消息 ===
            if (lastMessage.image_url || lastMessage.image_base64) {
                console.log('[Telegram Bridge] 检测到图片回复，跳过文本处理');
                lastProcessedChatId = null;
                return;
            }
            // === 结束新增 ===
            
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);
            
            if (messageElement.length > 0) {
                // 原有的文本处理代码...
```

---

### 步骤 4: 检查并调整 `sendMessageAsUser` 调用方式

**问题**: 原代码使用 `sendMessageAsUser(data.text)` 只支持文本。

**解决方案 A (推荐)**: 如果 SillyTavern 支持多媒体消息 API

查找 SillyTavern 的 `script.js` 或相关文档，找到正确的函数。可能是：
- `sendMessageAsUser({ text, image, ... })`
- `sendMediaToChat({ type: 'image', ... })`
- 其他多媒体 API

**解决方案 B (备用)**: 使用文件上传 API

如果无法直接发送图片，可以尝试：
1. 先将图片保存到临时文件
2. 使用文件上传接口
3. 获取文件 ID 后再发送

```javascript
// 示例：上传图片文件
async function uploadImageToSillyTavern(base64Image, mimeType) {
    // 将 base64 转换为 Blob
    const byteCharacters = atob(base64Image.split(',')[1]);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });
    
    // 创建 FormData 并上传
    const formData = new FormData();
    formData.append('file', blob, 'telegram_image.jpg');
    
    const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
    });
    
    const result = await response.json();
    return result.fileId; // 返回文件 ID
}
```

---

## 验证修改

1. 保存修改后的 `index.js`
2. 在 SillyTavern 中重新加载扩展（或刷新页面）
3. 查看浏览器控制台，确认没有 JavaScript 错误
4. 测试发送图片到 Telegram 机器人
5. 检查服务器日志和 SillyTavern 界面

## 调试技巧

1. **打开浏览器开发者工具** (F12)
2. **查看 Console 标签**: 查看 `[Telegram Bridge]` 开头的日志
3. **查看 Network 标签**: 检查 WebSocket 消息
4. **查看 SillyTavern 控制台**: 检查是否有错误

### 关键日志点

- `[Telegram Bridge] 收到用户图片` → 服务器正确发送了图片
- `[Telegram Bridge] 检测到AI生成图片` → 扩展检测到图片生成事件
- `[Telegram Bridge] 图片已发送到Telegram服务器` → 服务器收到图片并转发

## 常见错误

### 错误 1: `sendMessageAsUser is not a function`

**原因**: 函数名不正确或 API 已变更

**解决**: 查看 SillyTavern 的 `script.js` 找到正确的函数名

```javascript
// 在浏览器控制台运行，查看可用的函数
console.log(Object.keys(window.SillyTavern || {}));
```

### 错误 2: 图片显示为文本

**原因**: 图片被当作文本消息处理

**解决**: 确保 `handleFinalMessage` 中正确检测并跳过了图片消息

### 错误 3: 图片发送失败

**原因**: base64 格式不正确或 MIME 类型错误

**解决**: 检查服务器发送的图片数据格式，确保是完整的 `data:image/jpeg;base64,...` 格式

---

## 完成检查清单

- [ ] 服务器端已更新到最新代码（包含图片处理函数）
- [ ] 扩展 `index.js` 已添加 `user_image` 消息处理
- [ ] 扩展已添加图片生成事件监听
- [ ] `handleFinalMessage` 已跳过图片消息
- [ ] 已确认 `sendMessageAsUser` 或其他 API 的正确用法
- [ ] 所有修改已保存并重新加载扩展
- [ ] 测试：从 Telegram 发送图片到 SillyTavern ✅
- [ ] 测试：从 SillyTavern 发送图片到 Telegram ✅

---

## 需要你确认的事项

1. **SillyTavern 版本**: 请确认你使用的 SillyTavern 版本（主分支还是特定版本）
2. **是否启用图片生成**: 确认你的 AI 角色/模型支持图片生成（如 DALL-E、Midjourney 等）
3. **事件类型**: 在 SillyTavern 控制台运行以下代码确认图片事件名称：

```javascript
// 在 SillyTavern 页面控制台运行
console.log('Available event types:', Object.values(SillyTavern.event_types || {}));
```

将输出结果告诉我，我可以帮你调整事件监听代码。
