var DEFAULT_PROMPTS = [
  {
    id: 'default_painting',
    name: '🎨 提取绘画词 (默认)',
    content: '你是一位专业的AI绘画提示词逆向工程师。请分析这张图片的核心视觉特征，聚焦于能让AI复现此图的关键信息。\n\n分析原则：\n- 只描述你能明确看到的内容，不要猜测或编造\n- 抓大放小：优先描述决定整体画面感的要素（主体、风格、光影、氛围），次要细节可省略\n- 根据图片类型自适应：人物图侧重外貌服饰，风景图侧重场景氛围，插画图侧重画风技法\n\n请返回纯JSON（不要返回任何markdown标记如```，只返回合法的JSON字符串）：\n{\n  "title": "6字以内的中文标题",\n  "ratio": "宽高比，如 2:3",\n  "description": "80-150字中文核心描述，像给画师的简明创作brief",\n  "tags": ["5-6个最关键的特征标签"],\n  "prompt_en": "英文SD/MJ提示词，50-120词，按权重从高到低排列，逗号分隔"\n}'
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
