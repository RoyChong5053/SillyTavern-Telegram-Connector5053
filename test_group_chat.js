// 群聊功能测试脚本
// 模拟群聊中@bot的消息处理

const config = require('./server/config');

// 模拟不同的消息场景
const testMessages = [
    // 私聊消息（应该正常处理）
    {
        chat: { id: 123, type: 'private' },
        from: { id: 456, username: 'testuser' },
        text: 'Hello bot'
    },
    
    // 群聊消息但没有@bot（应该被忽略）
    {
        chat: { id: 789, type: 'group' },
        from: { id: 456, username: 'testuser' },
        text: 'Hello everyone'
    },
    
    // 群聊消息且@bot（应该处理）
    {
        chat: { id: 789, type: 'group' },
        from: { id: 456, username: 'testuser' },
        text: '@testbot Hello bot'
    },
    
    // 群聊消息且@bot带空格（应该处理）
    {
        chat: { id: 789, type: 'group' },
        from: { id: 456, username: 'testuser' },
        text: '@testbot   Hello bot'
    },
    
    // 群聊消息且@bot在中间（应该处理）
    {
        chat: { id: 789, type: 'group' },
        from: { id: 456, username: 'testuser' },
        text: 'Hey @testbot can you help me?'
    },
    
    // 群聊消息但@的是其他bot（应该忽略）
    {
        chat: { id: 789, type: 'group' },
        from: { id: 456, username: 'testuser' },
        text: '@otherbot Hello'
    }
];

// 测试消息处理逻辑
function processMessage(msg, botUsername = 'testbot') {
    const isGroupChat = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const text = msg.text || '';
    
    console.log(`\n测试消息: "${text}"`);
    console.log(`聊天类型: ${msg.chat.type}`);
    
    // 检查是否是群聊消息且@了bot
    if (isGroupChat && !text.includes(`@${botUsername}`)) {
        console.log('结果: 忽略（群聊消息但没有@bot）');
        return null;
    }
    
    // 移除文本消息中的@bot提及（如果是群聊）
    let processedText = text;
    if (isGroupChat && botUsername) {
        processedText = text.replace(new RegExp(`@${botUsername}\\s*`, 'g'), '').trim();
        
        // 如果处理后为空字符串，则忽略
        if (!processedText) {
            console.log('结果: 忽略（处理后为空消息）');
            return null;
        }
    }
    
    console.log(`处理后文本: "${processedText}"`);
    console.log('结果: 处理');
    return processedText;
}

// 运行测试
console.log('=== 群聊功能测试 ===');
console.log(`Bot用户名: testbot`);

let processedCount = 0;
let ignoredCount = 0;

testMessages.forEach((msg, index) => {
    console.log(`\n--- 测试 ${index + 1} ---`);
    const result = processMessage(msg);
    
    if (result === null) {
        ignoredCount++;
    } else {
        processedCount++;
    }
});

console.log(`\n=== 测试结果 ===`);
console.log(`总共测试消息: ${testMessages.length}`);
console.log(`处理的消息: ${processedCount}`);
console.log(`忽略的消息: ${ignoredCount}`);

// 验证预期结果
const expectedProcessed = 4; // 应该处理4条消息（1条私聊 + 3条群聊@bot）
const expectedIgnored = 2;   // 应该忽略2条消息（群聊没有@bot）

if (processedCount === expectedProcessed && ignoredCount === expectedIgnored) {
    console.log('✅ 测试通过！');
} else {
    console.log('❌ 测试失败！');
    console.log(`预期处理: ${expectedProcessed}, 实际处理: ${processedCount}`);
    console.log(`预期忽略: ${expectedIgnored}, 实际忽略: ${ignoredCount}`);
}