# 图片功能支持说明

本文档说明如何在 SillyTavern Telegram Connector 中添加图片发送和接收功能。

## 已实现的服务器端功能

### 1. 接收 Telegram 图片

当用户向机器人发送图片时：
1. 服务器检测到 `msg.photo` 字段
2. 自动下载最大尺寸的图片
3. 转换为 base64 格式
4. 通过 WebSocket 发送 `user_image` 消息到 SillyTavern 扩展

消息格式：
```json
{
  "type": "user_image",
  "chatId": 123456789,
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  "caption": "用户输入的图片说明文字（可选）",
  "mimeType": "image/jpeg"
}
```

### 2. 接收 SillyTavern 生成的图片

当 AI 生成图片并返回时：
1. 扩展发送 `ai_image` 消息到服务器
2. 服务器接收图片数据（base64、URL 或 Buffer）
3. 自动发送到对应的 Telegram 用户

消息格式：
```json
{
  "type": "ai_image",
  "chatId": 123456789,
  "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...",
  "caption": "AI生成的图片说明（可选）"
}
```

## 需要修改的扩展端代码

你需要修改 `index.js` 扩展文件来支持图片消息。

### 修改 1: 处理用户发送的图片

在 `index.js` 的 `ws.onmessage` 处理函数中，添加对 `user_image` 消息类型的处理：

```javascript
// 在现有的 message 类型判断中添加：
if (data.type === 'user_image') {
    console.log('[Telegram Bridge] 收到用户图片，发送给AI...');
    
    // 将图片添加到用户消息中
    // 方法1: 如果 SillyTavern 支持在消息对象中添加图片字段
    await sendMessageAsUser({
        text: data.caption || '图片',
        image: data.image, // base64 图片数据
        mimeType: data.mimeType
    });
    
    // 后续的流式处理与文本消息相同...
    // 复制文本消息的处理逻辑：设置流式回调、监听事件等
    return;
}
```

**注意**: `sendMessageAsUser` 函数可能需要支持对象参数而不仅是文本。你需要检查 SillyTavern 的 API 文档，确认如何发送带图片的消息。

### 修改 2: 转发 AI 生成的图片

当 SillyTavern 生成图片时，你需要监听相关事件并发送 `ai_image` 消息：

```javascript
// 在 index.js 中添加图片事件监听
eventSource.on(event_types.IMAGE_GENERATED, async (imageData) => {
    if (ws && ws.readyState === WebSocket.OPEN && lastProcessedChatId) {
        console.log('[Telegram Bridge] 检测到AI生成图片，转发到Telegram...');
        
        ws.send(JSON.stringify({
            type: 'ai_image',
            chatId: lastProcessedChatId,
            image: imageData.url || imageData.base64, // 根据实际数据结构调整
            caption: imageData.caption || ''
        }));
    }
});
```

**注意**: 需要确认 SillyTavern 的事件类型常量。查看 `event_types` 对象，找到图片生成相关的事件名称（可能是 `IMAGE_GENERATED`、`IMAGE_CREATED` 或类似名称）。

### 修改 3: 更新 `handleFinalMessage` 函数

确保图片消息不会触发文本处理逻辑。可以在函数开头添加：

```javascript
function handleFinalMessage(lastMessageIdInChatArray) {
    // 获取当前消息内容，检查是否包含图片
    const context = SillyTavern.getContext();
    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;
    
    const lastMessage = context.chat[lastMessageIndex];
    
    // 如果是图片消息，跳过文本处理（图片已通过事件处理）
    if (lastMessage && lastMessage.image_url) {
        console.log('[Telegram Bridge] 检测到图片消息，跳过文本处理');
        lastProcessedChatId = null;
        return;
    }
    
    // 原有的文本处理逻辑...
}
```

## 测试步骤

1. **重启服务器**：
   ```bash
   cd server
   node server.js
   ```

2. **测试接收图片**：
   - 在 Telegram 中向机器人发送一张图片
   - 检查服务器日志是否显示"收到用户图片"
   - 检查 SillyTavern 是否收到了图片消息

3. **测试发送图片**：
   - 在 SillyTavern 中让 AI 生成一张图片（使用支持图片的模型如 DALL-E、Midjourney 等）
   - 检查服务器日志是否显示"收到AI生成的图片"
   - 检查 Telegram 是否收到了图片

## 常见问题

### Q1: `sendMessageAsUser` 不支持图片参数怎么办？

你需要修改扩展代码，使用 SillyTavern 的内部 API。可能的方案：

1. **使用扩展 API**: 查看 SillyTavern 的扩展开发文档，找到发送多媒体消息的正确方法。
2. **模拟粘贴**: 有些系统支持将图片粘贴到输入框，然后自动发送。
3. **直接调用后端**: 可能需要通过 API 调用将图片保存到聊天记录。

### Q2: 图片格式支持哪些？

目前支持：
- JPEG/JPG
- PNG
- GIF（静态）
- WebP

### Q3: 图片大小有限制吗？

Telegram 限制：
- 最大 10 MB 的图片（自动压缩）
- 建议限制在 5 MB 以内以保证速度

服务器处理：
- 图片会被转换为 base64，体积增大约 33%
- 确保 WebSocket 传输不会超时

### Q4: AI 生成图片时没有触发事件怎么办？

检查：
1. 确认 `event_types` 中是否有图片事件常量
2. 在 SillyTavern 设置中启用图片生成
3. 查看浏览器控制台，确认事件是否触发

## 安全注意事项

1. **文件类型验证**: 服务器应验证接收到的文件确实是图片
2. **大小限制**: 建议添加图片大小限制（如 5MB）
3. **内容审查**: 图片会经过 Telegram 的内容审查，但服务器端也应防范恶意内容
4. **白名单**: 已配置的用户白名单同样适用于图片消息

## 后续优化建议

1. **添加图片压缩**: 在上传前压缩图片以减少传输时间
2. **支持多张图片**: 一次发送多张图片（Telegram 支持相册）
3. **添加进度提示**: 大图片下载/上传时显示进度
4. **支持文档/视频**: 扩展到其他媒体类型
5. **错误恢复**: 图片发送失败时提供重试机制

## 参考资源

- [node-telegram-bot-api 文档](https://github.com/yagop/node-telegram-bot-api)
- [SillyTavern 扩展开发文档](https://docs.sillytavern.app/for-contributors/extensions/)
- [WebSocket 协议参考](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
