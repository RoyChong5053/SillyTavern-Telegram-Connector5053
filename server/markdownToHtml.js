// Markdown 到 HTML 转换工具
// 用于将Markdown格式转换为Telegram支持的HTML格式

function markdownToHtml(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }

    // 转义HTML特殊字符
    let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // 处理Markdown格式
    html = html
        // 先处理代码块 (避免被内联代码影响)
        .replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
            // 清理代码块中的多余换行
            const cleanedCode = code.trim();
            return `<pre><code class="language-${lang}">${cleanedCode}</code></pre>`;
        })
        // 粗体: **text** -> <b>text</b>
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        // 斜体: *text* -> <i>text</i>
        .replace(/\*(.*?)\*/g, '<i>$1</i>')
        // 下划线: __text__ -> <u>text</u>
        .replace(/__(.*?)__/g, '<u>$1</u>')
        // 删除线: ~~text~~ -> <s>text</s>
        .replace(/~~(.*?)~~/g, '<s>$1</s>')
        // 内联代码: `code` -> <code>code</code>
        .replace(/`(.*?)`/g, '<code>$1</code>')
        // 链接: [text](url) -> <a href="url">text</a>
        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>')
        // 换行: \n -> <br/>
        .replace(/\n/g, '<br/>');

    return html;
}

// Telegram HTML格式验证和清理
function sanitizeTelegramHtml(html) {
    if (!html || typeof html !== 'string') {
        return html;
    }

    // Telegram只支持特定的HTML标签: <b>, <strong>, <i>, <em>, <u>, <ins>, <s>, <strike>, <del>, <code>, <pre>
    // 移除不支持的HTML标签，但保留Telegram支持的标签
    let sanitized = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // 移除script标签
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // 移除style标签
        .replace(/<div[^>]*>/gi, '')                      // 移除div开始标签
        .replace(/<\/div>/gi, '')                       // 移除div结束标签
        .replace(/<span[^>]*>/gi, '')                   // 移除span开始标签
        .replace(/<\/span>/gi, '');                      // 移除span结束标签

    return sanitized;
}

// 主转换函数
function convertToTelegramHtml(markdownText) {
    const html = markdownToHtml(markdownText);
    return sanitizeTelegramHtml(html);
}

module.exports = {
    markdownToHtml,
    sanitizeTelegramHtml,
    convertToTelegramHtml
};