// ========== 右键菜单注册与动态更新 ==========
// 防抖变量，避免 storage.onChanged 连续触发导致 duplicate id
var _menuTimer = null;

function updateContextMenus() {
  // 先清除所有已有菜单，在回调中重建
  chrome.contextMenus.removeAll(function() {
    chrome.storage.local.get({ prompts: [] }, function(items) {
      var prompts = items.prompts || [];
      if (prompts.length === 0) return;

      // 创建主菜单（覆盖 image / page / video / frame，兼容抖音智能探测）
      chrome.contextMenus.create({
        id: "i2p-parent",
        title: "🔍 ImageToPrompt",
        contexts: ["image", "page", "video", "frame"]
      });

      // 为每个提示词创建子菜单
      for (var i = 0; i < prompts.length; i++) {
        chrome.contextMenus.create({
          id: "i2p_" + prompts[i].id,
          parentId: "i2p-parent",
          title: prompts[i].name,
          contexts: ["image", "page", "video", "frame"]
        });
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(function() {
  updateContextMenus();
});

// 监听 storage 变化以刷新菜单，带防抖
chrome.storage.onChanged.addListener(function(changes, namespace) {
  if (namespace === 'local' && changes.prompts) {
    clearTimeout(_menuTimer);
    _menuTimer = setTimeout(function() {
      updateContextMenus();
    }, 300);
  }
});

// ========== 右键菜单点击处理 ==========
// 兼容所有场景：标准 <img> 右键、抖音 background-image、视频帧截取等
chrome.contextMenus.onClicked.addListener(function(info, tab) {
  if (info.parentMenuItemId === "i2p-parent") {
    // 从子菜单 ID "i2p_xxx" 中解出真正的 promptId
    var promptId = info.menuItemId.replace(/^i2p_/, '');
    // 标准 <img> 右键有 srcUrl；抖音等非标准场景 srcUrl 为空，走 content.js 智能探测
    var src = (info.mediaType === 'image' && info.srcUrl) ? info.srcUrl : null;
    chrome.tabs.sendMessage(tab.id, {
      action: "analyzeImage",
      srcUrl: src,
      promptId: promptId
    });
  }
});

// ========== 快捷键触发（默认使用第一个提示词） ==========
chrome.commands.onCommand.addListener(function(command) {
  if (command === "trigger-i2p") {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0]) {
        chrome.storage.local.get({ prompts: [] }, function(items) {
          var defaultId = (items.prompts && items.prompts.length > 0) ? items.prompts[0].id : null;
          chrome.tabs.sendMessage(tabs[0].id, {
            action: "analyzeImage",
            srcUrl: null,
            promptId: defaultId
          });
        });
      }
    });
  }
});

// ========== 处理来自 content.js 的 API 请求 ==========
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchAnalysis') {
    handleFetchAnalysis(request.base64OrUrl, request.promptId)
      .then(result => sendResponse({success: true, data: result}))
      .catch(error => sendResponse({success: false, error: error.message}));
    return true;
  }
  // 裂变功能：基于图片描述生成 9 个分镜提示词
  if (request.action === 'fetchStoryboard') {
    handleFetchStoryboard(request.promptEn)
      .then(result => sendResponse({success: true, data: result}))
      .catch(error => sendResponse({success: false, error: error.message}));
    return true;
  }
});
// ========== 通用流式 API 请求（绕过反代非流式模式下的格式转译丢失问题） ==========
async function streamChatRequest(apiEndpoint, apiKey, model, messages) {
  const body = {
    model: model,
    stream: true,
    messages: messages,
  };

  const response = await fetch(apiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText.substring(0, 300)}`);
  }

  // 流式读取，逐块拼接 content
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let reasoningContent = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const chunk = JSON.parse(trimmed.slice(6));
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
      } catch (e) { /* 忽略解析失败的行 */ }
    }
  }

  // reasoning_content 后备
  if (!content && reasoningContent) {
    console.log('[ImageToPrompt] content 为空，使用 reasoning_content 作为后备');
    content = reasoningContent;
  }

  return content || null;
}

// ========== 视觉 API 调用 ==========
async function callVisionAPI(apiEndpoint, apiKey, model, promptText, imageUrl) {
  console.log(`[ImageToPrompt] 调用模型: ${model} (流式模式)`);

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    }
  ];

  const content = await streamChatRequest(apiEndpoint, apiKey, model, messages);
  console.log(`[ImageToPrompt] 流式结果: content长度=${(content || '').length}`);

  return {
    content,
    model,
    diag: { completionTokens: 0, reasoningTokens: 0, finishReason: 'stream' }
  };
}

// ========== 图片分析主流程（含自动降级） ==========
async function handleFetchAnalysis(imageUrl, promptId) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({
      apiUrl: 'https://api.moonshot.cn',
      apiKey: '',
      model: 'moonshot-v1-32k-vision',
      prompts: []
    }, async (items) => {
      if (!items.apiKey) {
        return reject(new Error('请先在插件选项页配置 API Key'));
      }

      let promptText = "";
      if (items.prompts && items.prompts.length > 0) {
        const p = items.prompts.find(x => x.id === promptId);
        promptText = p ? p.content : items.prompts[0].content;
      } else {
        promptText = `你是一位专业的AI绘画提示词逆向工程师。请分析这张图片的核心视觉特征，聚焦于能让AI复现此图的关键信息。

分析原则：
- 只描述你能明确看到的内容，不要猜测或编造
- 抓大放小：优先描述决定整体画面感的要素（主体、风格、光影、氛围），次要细节可省略
- 根据图片类型自适应：人物图侧重外貌服饰，风景图侧重场景氛围，插画图侧重画风技法

请返回纯JSON（不要返回任何markdown标记如\`\`\`，只返回合法的JSON字符串）：
{
  "title": "6字以内的中文标题",
  "ratio": "宽高比，如 2:3",
  "description": "80-150字中文核心描述，像给画师的简明创作brief",
  "tags": ["5-6个最关键的特征标签"],
  "prompt_en": "英文SD/MJ提示词，50-120词，按权重从高到低排列，逗号分隔"
}`;
      }

      try {
        // 图片转 Base64（必须！抖音等 CDN 链接有防盗链，OpenAI 服务器无法直接访问）
        let finalImageUrl = imageUrl;
        if (!imageUrl.startsWith('data:')) {
          try {
            const imgRes = await fetch(imageUrl, { referrerPolicy: 'no-referrer' });
            const blob = await imgRes.blob();
            finalImageUrl = await new Promise((res) => {
              const reader = new FileReader();
              reader.onloadend = () => res(reader.result);
              reader.readAsDataURL(blob);
            });
            console.log(`[ImageToPrompt] 图片已转 base64, 原URL长度: ${imageUrl.length}, base64长度: ${finalImageUrl.length}`);
          } catch (e) {
            console.warn("[ImageToPrompt] 图片转 Base64 失败，降级使用原生 URL", e);
          }
        } else {
          console.log(`[ImageToPrompt] 图片已是 base64(视频帧截取), 长度: ${imageUrl.length}`);
        }

        // 补全 API 路径
        let apiEndpoint = items.apiUrl.replace(/\/+$/, '');
        if (!apiEndpoint.endsWith('/chat/completions')) {
          if (!apiEndpoint.endsWith('/v1')) {
            apiEndpoint += '/v1/chat/completions';
          } else {
            apiEndpoint += '/chat/completions';
          }
        }

        // ===== 调用用户配置的模型 =====
        const result = await callVisionAPI(apiEndpoint, items.apiKey, items.model, promptText, finalImageUrl);

        if (!result.content) {
          const d = result.diag;
          throw new Error(`模型返回空内容\n\n诊断: completion=${d.completionTokens}, reasoning=${d.reasoningTokens}, output≈${d.completionTokens - d.reasoningTokens}, finish=${d.finishReason}\n\n这通常是 API 服务端的内容审核导致的，请检查反代后台日志`);
        }

        // ===== 解析 JSON =====
        let content = result.content.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
          const parsed = JSON.parse(content);
          resolve(parsed);
        } catch (e) {
          reject(new Error('模型返回的数据无法解析为 JSON: ' + content));
        }

      } catch (err) {
        reject(err);
      }
    });
  });
}

// ========== 裂变功能：基于英文描述生成 9 个 NanoBananaPro 分镜 ==========
async function handleFetchStoryboard(promptEn) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({
      apiUrl: 'https://api.moonshot.cn',
      apiKey: '',
      model: 'moonshot-v1-32k-vision'
    }, async (items) => {
      if (!items.apiKey) {
        return reject(new Error('请先在插件选项页配置 API Key'));
      }

      // 裂变系统提示词（NanoBananaPro 视角裂变专家）
      const systemPrompt = `你是一位多维视角一致性生成助手，专精于 AI 漫画分镜创作。

任务：基于用户提供的参考图描述，保持视觉锚点绝对不变，生成 9 个极具沉浸感的分镜提示词。

镜头变量库：
- 景别（禁用 Medium Shot / Long Shot / Close-up）：Extreme Close-up (ECU), Full Body Shot, Cowboy Shot (Thigh-up), Upper Body Shot (Chest-up), Wide Angle Full Shot
- 视角：Back View, Over-the-Shoulder (OTS), Point of View (POV), Low Angle, High Angle, Dutch Angle, Top-Down
- 构图：Rule of Thirds, Center Composition, Depth of Field, Framing within a frame, Dynamic Diagonal

视角强制分配：
- 2 个背后视角 (Back View)
- 3 个过肩视角 (OTS)
- 2 个主观视角 (POV)
- 2 个自由选择高张力视角

约束：
1. 人物特征和环境在 9 个分镜中保持绝对一致
2. 严禁 "Medium Shot", "Long Shot", "Close-up" 等平庸描述
3. 每个 prompt 末尾必须包含 "No text overlay, no timecode, no subtitles, no watermark."
4. Prompt 内容必须为英文
5. 只返回纯 JSON，不要任何 markdown 标记

返回格式：
{
  "image_generation_model": "NanoBananaPro",
  "grid_layout": "3x3",
  "grid_aspect_ratio": "16:9",
  "shots": [
    { "shot_number": "分镜1", "prompt_text": "..." },
    ...共 9 个
  ]
}`;

      try {
        let apiEndpoint = items.apiUrl.replace(/\/+$/, '');
        if (!apiEndpoint.endsWith('/chat/completions')) {
          if (!apiEndpoint.endsWith('/v1')) {
            apiEndpoint += '/v1/chat/completions';
          } else {
            apiEndpoint += '/chat/completions';
          }
        }

        console.log(`[ImageToPrompt] 裂变调用模型: ${items.model} (流式模式)`);

        // 使用流式请求（与图片分析一致，绕过反代格式转译问题）
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: `参考图描述：${promptEn}` }
        ];

        const content = await streamChatRequest(apiEndpoint, items.apiKey, items.model, messages);
        if (!content) {
          throw new Error('模型未返回裂变内容（content 为空）');
        }

        const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          resolve(parsed);
        } catch (e) {
          reject(new Error('裂变结果无法解析为 JSON: ' + cleaned));
        }
      } catch (err) {
        reject(err);
      }
    });
  });
}
