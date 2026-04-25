var DEFAULT_PROMPTS = [
  {
    id: 'default_painting',
    name: '🎨 提取绘画词 (默认)',
    content: '你是一位专业的AI绘画提示词逆向工程师。请分析这张图片的核心视觉特征，聚焦于能让AI复现此图的关键信息。\n\n分析原则：\n- 只描述你能明确看到的内容，不要猜测或编造\n- 抓大放小：优先描述决定整体画面感的要素，次要细节可省略\n- 根据图片类型自适应：人物图侧重外貌服饰，风景图侧重场景氛围，插画图侧重画风技法\n\ndescription 字段必须使用【】分区，格式如下：\n【风格】一句话概括画风/媒介（如：赛博朋克数字插画、水彩风景、电影级摄影）\n【构图】视角、景别、主体位置、画面层次（如：低角度仰拍、主体居中、前景虚化）\n【主体】核心对象的关键外观描述（外貌/服饰/姿态 或 场景核心物）\n【光色】光源方向、色温、整体色调、氛围（如：金色侧逆光、暖调、晨雾氛围）\n【细节】1-2个最出彩的画面细节（如：发丝光晕、地面反射、烟雾粒子）\n每个分区1-2句话，总计100-200字。不要写成长段落。\n\n请返回纯JSON（不要返回任何markdown标记如```，只返回合法的JSON字符串）：\n{\n  "title": "6字以内的中文标题",\n  "ratio": "宽高比，如 2:3",\n  "description": "使用【】分区的结构化描述",\n  "tags": ["5-8个最关键的特征标签"],\n  "prompt_en": "英文SD/MJ提示词，50-120词，按权重从高到低排列，逗号分隔"\n}'
  },
  {
    id: 'default_poster',
    name: '🖼️ 信息图/海报逆向',
    content: '你是一位资深平面设计逆向分析师。请拆解这张信息图/海报/设计稿的设计手法，提取可复刻的结构化要素。\n\n分析原则：\n- 聚焦"设计方法论"而非内容本身（不需要逐字提取文案）\n- 像给设计师写复刻brief：读完就能用Figma/PS做出同风格的图\n- 每个分区精简到关键词+一句解释，不要写长段落\n\ndescription 字段必须使用【】分区，格式如下：\n【风格定位】一句话定义整体设计风格（如：国潮卷轴风、日式极简信息图、扁平科普长图）\n【版式结构】画面如何划分区域、内容的视觉流动方向（如：中轴对称、Z字型阅读流、卡片网格2×4、左图右文上下三段式）\n【配色方案】主色+辅助色+点缀色，用具体色彩描述（如：米白底 #F5F0E8 + 墨绿标题 + 烫金强调 + 朱红点缀）\n【字体排印】标题/正文/标注各自的字体风格和层级关系（如：标题手写书法体、正文无衬线、标注小号灰色衬线）\n【核心元素】画面中最有辨识度的视觉元素清单，3-6个（如：水墨山峦剪影、圆角卡片、手绘箭头连接线、印章装饰、半透明叠加层）\n【复刻要点】如果要做同风格的图，最关键的2-3个注意事项\n\n请返回纯JSON（不要返回任何markdown标记如```，只返回合法的JSON字符串）：\n{\n  "title": "6字以内的中文标题",\n  "ratio": "宽高比，如 3:4",\n  "description": "使用【】分区的结构化设计拆解",\n  "tags": ["6-10个设计特征标签，如：竖版科普海报、国潮配色、卡片布局"],\n  "prompt_en": "English prompt to recreate this design style, 60-150 words, covering: style, layout, color palette, typography, key visual elements"\n}'
  },
  {
    id: 'default_ocr',
    name: '📝 提取图中文案',
    content: '你是一个专业的图文转录助手。请精准提取图片中的所有文本内容。\n\n分析要求：\n- 请按照视觉从上到下、从左到右的顺序提取\n- 忽略没有实际文字意义的背景杂色\n- 如果有段落，请保持段落分割\n\n请返回纯JSON，不要返回多余标记：\n{\n  "title": "文档/图片名称",\n  "ratio": "宽高比",\n  "description": "这里放入提取出的完整文本内容，不要修改源文案，适度排版",\n  "tags": ["语言","排版类型"],\n  "prompt_en": "Text transcription complete."\n}'
  }
];

var currentPrompts = [];
var activePromptId = null;

// 显示保存成功提示
function showStatus(msg) {
  var status = document.getElementById('status');
  status.textContent = msg;
  status.style.display = 'block';
  setTimeout(function() {
    status.style.display = 'none';
  }, 2000);
}

// 生成唯一ID
function generateId() {
  return 'p_' + Math.random().toString(36).substr(2, 9);
}

// 渲染左侧提示词列表
function renderPromptList() {
  var listEl = document.getElementById('promptList');
  listEl.innerHTML = '';

  for (var i = 0; i < currentPrompts.length; i++) {
    var p = currentPrompts[i];
    var item = document.createElement('div');
    item.className = 'prompt-item' + (p.id === activePromptId ? ' active' : '');

    var span = document.createElement('span');
    span.className = 'prompt-item-name';
    span.textContent = p.name;
    item.appendChild(span);

    // 用闭包绑定 id
    item.addEventListener('click', (function(id) {
      return function() { selectPrompt(id); };
    })(p.id));

    listEl.appendChild(item);
  }
}

// 选中某个提示词，填入右侧编辑区
function selectPrompt(id) {
  activePromptId = id;
  var p = null;
  for (var i = 0; i < currentPrompts.length; i++) {
    if (currentPrompts[i].id === id) { p = currentPrompts[i]; break; }
  }
  if (p) {
    document.getElementById('promptName').value = p.name;
    document.getElementById('promptText').value = p.content;
    document.getElementById('promptEditor').style.display = 'block';
  }
  renderPromptList();
}

// 保存全局设置（API/Key/Model）
function saveGlobalOptions() {
  var apiUrl = document.getElementById('apiUrl').value.trim();
  var apiKey = document.getElementById('apiKey').value.trim();
  var model  = document.getElementById('modelName').value.trim();

  chrome.storage.local.set({ apiUrl: apiUrl, apiKey: apiKey, model: model }, function() {
    showStatus('全局设置已保存！');
  });
}

// 保存当前正在编辑的提示词
function saveCurrentPrompt() {
  if (!activePromptId) return;
  var name    = document.getElementById('promptName').value.trim();
  var content = document.getElementById('promptText').value.trim();

  if (!name) { alert('请填写提示词名称'); return; }

  for (var i = 0; i < currentPrompts.length; i++) {
    if (currentPrompts[i].id === activePromptId) {
      currentPrompts[i].name = name;
      currentPrompts[i].content = content;
      break;
    }
  }

  chrome.storage.local.set({ prompts: currentPrompts }, function() {
    showStatus('提示词已保存并生效！');
    renderPromptList();
  });
}

// 页面加载时恢复数据，并处理旧版迁移
function restoreOptions() {
  chrome.storage.local.get({
    apiUrl: 'https://api.moonshot.cn',
    apiKey: '',
    model: 'moonshot-v1-32k-vision',
    promptText: '',
    prompts: null
  }, function(items) {
    document.getElementById('apiUrl').value = items.apiUrl;
    document.getElementById('apiKey').value = items.apiKey;
    document.getElementById('modelName').value = items.model;

    // 迁移与初始化
    if (items.prompts && items.prompts.length > 0) {
      // 已有新版数据
      currentPrompts = items.prompts;
    } else if (items.promptText && items.promptText.length > 0) {
      // 旧版有自定义提示词 → 迁移 + 追加默认模板
      currentPrompts = [{
        id: generateId(),
        name: '🎨 我的提示词 (旧版迁移)',
        content: items.promptText
      }].concat(DEFAULT_PROMPTS);
    } else {
      // 全新安装
      currentPrompts = JSON.parse(JSON.stringify(DEFAULT_PROMPTS));
    }

    // 清理旧字段
    if (items.promptText) {
      chrome.storage.local.remove('promptText');
    }

    // 写入新结构
    chrome.storage.local.set({ prompts: currentPrompts });

    renderPromptList();
    if (currentPrompts.length > 0) {
      selectPrompt(currentPrompts[0].id);
    }
  });
}

// ========== 事件绑定 ==========
document.addEventListener('DOMContentLoaded', restoreOptions);

document.getElementById('saveGlobalBtn').addEventListener('click', saveGlobalOptions);
document.getElementById('savePromptBtn').addEventListener('click', saveCurrentPrompt);

document.getElementById('addPromptBtn').addEventListener('click', function() {
  var newId = generateId();
  currentPrompts.push({
    id: newId,
    name: '新建提示词',
    content: ''
  });
  selectPrompt(newId);
});

document.getElementById('deletePromptBtn').addEventListener('click', function() {
  if (currentPrompts.length <= 1) {
    alert('至少需要保留一个提示词配置。');
    return;
  }
  if (confirm('确定要删除此提示词吗？此操作不可恢复。')) {
    currentPrompts = currentPrompts.filter(function(x) { return x.id !== activePromptId; });
    activePromptId = currentPrompts[0].id;

    chrome.storage.local.set({ prompts: currentPrompts }, function() {
      selectPrompt(activePromptId);
      showStatus('提示词已删除');
    });
  }
});
