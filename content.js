// ========== 右键元素追踪 ==========
// 记录用户最后右键点击的元素及坐标，供后续智能探测使用
let lastContextTarget = null;
let lastContextPos = { x: 0, y: 0 };

document.addEventListener('contextmenu', (e) => {
  lastContextTarget = e.target;
  lastContextPos = { x: e.clientX, y: e.clientY };
}, true);

// 监听来自后台的消息
let activePromptId = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyzeImage') {
    activePromptId = request.promptId;
    // 如果后台传来了 srcUrl（标准 <img> 右键），直接使用
    if (request.srcUrl) {
      showOverlay(request.srcUrl);
      return;
    }
    // 否则进入智能探测流程
    const result = findImageSource(lastContextTarget);
    if (result) {
      showOverlay(result);
    } else {
      showError('未能在当前位置检测到图片或视频，请尝试直接右键点击图片元素。');
    }
  }
});

// ========== 智能图片源探测 ==========
// 依次尝试：当前元素 → 子元素 → 父级链，最多上溯 8 层
function findImageSource(el) {
  if (!el) return null;

  // 0-A. 小红书专用探测路径（优先级最高，避免遮罩层干扰）
  const xhsResult = findXhsImage(el);
  if (xhsResult) return xhsResult;

  // 0-B. 智能选择页面中当前活跃的视频（抖音有多个预加载的 video 元素）
  const bestVideo = findActiveVideo();
  if (bestVideo) {
    const frame = captureVideoFrame(bestVideo);
    if (frame) return frame;
  }

  // 1. 当前元素直接检测
  const direct = extractFromElement(el);
  if (direct) return direct;

  // 2. 向子元素查找（深度 3 层）
  const child = findInChildren(el, 3);
  if (child) return child;

  // 3. 向父级遍历（最多上溯 8 层）
  let parent = el.parentElement;
  for (let i = 0; i < 8 && parent; i++) {
    const fromParent = extractFromElement(parent);
    if (fromParent) return fromParent;

    const sibling = findInChildren(parent, 2);
    if (sibling) return sibling;

    parent = parent.parentElement;
  }

  // 4. 兜底：穿透遮罩层，尝试获取点击坐标下所有重叠元素
  if (lastContextPos.x && lastContextPos.y) {
    const allEls = document.elementsFromPoint(lastContextPos.x, lastContextPos.y);
    for (const candidate of allEls) {
      if (candidate === el) continue; // 跳过已检测过的触发元素
      const result = extractFromElement(candidate);
      if (result) return result;
    }
  }

  return null;
}

// 从单个元素提取图片源
function extractFromElement(el) {
  if (!el) return null;

  // <img> 标签
  if (el.tagName === 'IMG' && el.src) {
    return el.src;
  }

  // <video> 标签 → 截取当前帧
  if (el.tagName === 'VIDEO') {
    return captureVideoFrame(el);
  }

  // <canvas> 标签
  if (el.tagName === 'CANVAS') {
    try {
      return el.toDataURL('image/png');
    } catch (e) {
      // canvas 可能被污染（tainted），跨域时无法导出
      console.warn('Canvas toDataURL 失败（可能跨域污染）', e);
    }
  }

  // <source> 的父级 <picture> / <video>
  if (el.tagName === 'SOURCE' && el.parentElement) {
    return extractFromElement(el.parentElement);
  }

  // CSS background-image
  const bg = getBackgroundImageUrl(el);
  if (bg) return bg;

  // poster 属性（video 封面）
  if (el.poster) return el.poster;

  return null;
}

// ========== 小红书专用图片探测 ==========
// 处理小红书特有的 DOM 结构：Feed 流 background-image + 遮罩层、详情页 Swiper 轮播、XGPlayer 视频
function findXhsImage(el) {
  // 仅在小红书域名下生效
  if (!location.hostname.includes('xiaohongshu.com')) return null;

  // 场景 A：详情页（弹窗模态或独立页面）
  const noteDetail = document.querySelector('#noteContainer, .note-detail-mask, .note-detail');
  if (noteDetail) {
    // A-1. 图片笔记：取当前 active slide 中的 img（Swiper 轮播）
    const activeImg = noteDetail.querySelector(
      '.swiper-slide-active img, .swiper-slide-active .slide-container img'
    );
    if (activeImg && activeImg.src && !activeImg.src.includes('avatar')) {
      return activeImg.src;
    }

    // A-2. 单图笔记（无轮播，直接展示）
    const singleImg = noteDetail.querySelector('.note-slider-img, .media-container img');
    if (singleImg && singleImg.src) return singleImg.src;

    // A-3. 详情页所有大尺寸 img 兜底
    const allImgs = noteDetail.querySelectorAll('img[src]');
    for (const img of allImgs) {
      // 跳过头像、icon 等小图
      if ((img.naturalWidth >= 200 || img.width >= 200 || img.offsetWidth >= 200)
          && !img.src.includes('avatar') && !img.src.includes('emoji')) {
        return img.src;
      }
    }

    // A-4. 视频笔记：截取当前帧（XGPlayer 的 video 在自定义标签内）
    const video = noteDetail.querySelector('video');
    if (video) return captureVideoFrame(video);
  }

  // 场景 B：Feed 流（发现页 / 搜索结果）
  // 从右键元素向上查找最近的笔记卡片容器
  const card = el.closest('section, [class*="note-item"], a[class*="cover"]');
  if (card) {
    // B-1. 检查卡片封面的 background-image（小红书 Feed 典型结构）
    const coverEl = card.matches('[class*="cover"]')
      ? card
      : card.querySelector('a[class*="cover"], [class*="cover"]');
    if (coverEl) {
      const bg = getBackgroundImageUrl(coverEl);
      if (bg) return bg;
    }

    // B-2. 也可能有标准 <img>（新版小红书部分卡片已改用 img）
    const img = card.querySelector('img[src]');
    if (img && (img.naturalWidth >= 100 || img.width >= 100 || img.offsetWidth >= 100)) {
      return img.src;
    }
  }

  // 场景 C：右键元素自身就是带背景图的容器
  const bg = getBackgroundImageUrl(el);
  if (bg) return bg;

  return null;
}

// 在页面所有 video 中找到当前活跃的那个（抖音等 SPA 会预加载多个 video）
function findActiveVideo() {
  const allVideos = Array.from(document.querySelectorAll('video'));
  if (allVideos.length === 0) return null;
  if (allVideos.length === 1) {
    const v = allVideos[0];
    return (v.readyState >= 2 && v.videoWidth > 100) ? v : null;
  }

  // 全屏时优先取全屏容器内的 video
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    const fsVideo = fsEl.tagName === 'VIDEO' ? fsEl : fsEl.querySelector('video');
    if (fsVideo && fsVideo.readyState >= 2 && fsVideo.videoWidth > 100) {
      return fsVideo;
    }
  }

  // 过滤出已加载的 video
  const ready = allVideos.filter(v => v.readyState >= 2 && v.videoWidth > 100);
  if (ready.length === 0) return null;
  if (ready.length === 1) return ready[0];

  // 优先选正在播放（未暂停）的
  const playing = ready.filter(v => !v.paused && !v.ended);
  if (playing.length === 1) return playing[0];

  // 多个在播/全部暂停时，选在视口中可见面积最大的
  let best = null;
  let bestArea = 0;
  for (const v of ready) {
    const rect = v.getBoundingClientRect();
    // 计算视口内可见部分的面积
    const visibleW = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visibleH = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const area = visibleW * visibleH;
    if (area > bestArea) {
      bestArea = area;
      best = v;
    }
  }

  return best;
}

// 在子元素树中查找图片源（带深度限制）
function findInChildren(el, maxDepth) {
  if (maxDepth <= 0 || !el) return null;

  // 优先找 video（视频站点视频是主内容）
  const video = el.querySelector('video');
  if (video && video.readyState >= 2 && video.videoWidth > 100) {
    const frame = captureVideoFrame(video);
    if (frame) return frame;
  }

  // 再找大尺寸 img（跳过头像等小图）
  const imgs = el.querySelectorAll('img[src]');
  for (const img of imgs) {
    if (img.naturalWidth >= 200 || img.width >= 200 || img.offsetWidth >= 200) {
      return img.src;
    }
  }

  // 如果没有大图，退而求其次取任何 img
  if (imgs.length > 0) return imgs[0].src;

  // 再找有 background-image 的子元素
  const children = el.children;
  for (let i = 0; i < children.length && i < 20; i++) {
    const bg = getBackgroundImageUrl(children[i]);
    if (bg) return bg;

    const deeper = findInChildren(children[i], maxDepth - 1);
    if (deeper) return deeper;
  }

  return null;
}

// 提取 CSS background-image URL
function getBackgroundImageUrl(el) {
  if (!el) return null;
  try {
    const style = getComputedStyle(el);
    const bg = style.backgroundImage;
    if (bg && bg !== 'none') {
      // 匹配 url("...")  url('...')  url(...)
      const match = bg.match(/url\(["']?(.*?)["']?\)/);
      if (match && match[1] && !match[1].startsWith('data:image/svg')) {
        return match[1];
      }
    }
  } catch (e) {
    // getComputedStyle 在某些情况下可能失败
  }
  return null;
}

// 截取 video 当前帧为 data URL
function captureVideoFrame(video) {
  try {
    if (!video.videoWidth || !video.videoHeight) {
      // 视频可能还没加载到有效帧
      // 尝试使用 poster
      if (video.poster) return video.poster;
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch (e) {
    console.warn('视频帧截取失败', e);
    // 降级使用 poster
    if (video.poster) return video.poster;
    return null;
  }
}

// ========== 显示错误提示 ==========
function showError(msg) {
  let existing = document.getElementById('i2p-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'i2p-overlay';
  overlay.innerHTML = `
    <div class="i2p-modal" style="max-width:480px;height:auto;max-height:200px;align-items:center;justify-content:center;padding:40px;">
      <div class="i2p-close" id="i2p-btn-close">&times;</div>
      <div style="text-align:center;">
        <div style="font-size:36px;margin-bottom:12px;">🔍</div>
        <div style="color:rgba(255,255,255,0.8);font-size:14px;line-height:1.6;">${msg}</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  document.getElementById('i2p-btn-close').addEventListener('click', () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  });
}

// ========== 主弹窗逻辑 ==========
let currentData = null;

function showOverlay(imgUrl) {
  let existing = document.getElementById('i2p-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'i2p-overlay';

  // 判断是否为 data URL（来自视频截帧），用于左侧展示
  const isDataUrl = imgUrl.startsWith('data:');

  overlay.innerHTML = `
    <div class="i2p-modal">
      <div class="i2p-close" id="i2p-btn-close">&times;</div>
      <div class="i2p-left">
        <img src="${imgUrl}" alt="Source Image">
        ${isDataUrl ? '<div class="i2p-video-badge">📹 视频帧截取</div>' : ''}
      </div>
      <div class="i2p-right" id="i2p-dynamic-content">
        <div class="i2p-loading-container">
          <div class="i2p-spinner"></div>
          <div class="i2p-loading-text">反推神经连接中...</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.add('show');
  });

  document.getElementById('i2p-btn-close').addEventListener('click', () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  });

  // 通知后台开始请求大模型
  chrome.runtime.sendMessage({ action: 'fetchAnalysis', base64OrUrl: imgUrl, promptId: activePromptId }, (response) => {
    const contentBox = document.getElementById('i2p-dynamic-content');
    if (!contentBox) return;

    if (response && response.success && response.data) {
      currentData = response.data;
      renderResult(contentBox, currentData);
    } else {
      contentBox.innerHTML = `
        <div style="color: #ff6b6b; font-size: 14px; margin-top: 50px;">
          <h3>请求失败</h3>
          <p>${response?.error || '未知错误，请检查 API Key 和网络配置'}</p>
        </div>
      `;
    }
  });
}

/**
 * 将 description 中的【】分区标记渲染为结构化 HTML
 * 如果没有【】标记，返回纯文本（向后兼容）
 */
function formatDescription(text) {
  if (!text) return { html: '', isStructured: false };
  // 检测是否包含【】分区标记
  const sectionPattern = /【([^】]+)】/g;
  if (!sectionPattern.test(text)) {
    // 纯文本模式：转义 HTML 并保留换行
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { html: escaped.replace(/\n/g, '<br>'), isStructured: false };
  }
  // 结构化模式：按【】拆分为分区
  const sections = [];
  const lines = text.split('\n');
  let currentSection = null;
  for (const line of lines) {
    const match = line.match(/^【([^】]+)】(.*)/);
    if (match) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: match[1], content: match[2].trim() };
    } else if (currentSection) {
      // 追加内容到当前分区
      if (line.trim()) {
        currentSection.content += (currentSection.content ? '\n' : '') + line.trim();
      }
    }
  }
  if (currentSection) sections.push(currentSection);
  // 生成 HTML
  const html = sections.map(s => {
    const contentEscaped = s.content
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    return `<div class="i2p-section">
      <div class="i2p-section-title">` + s.title + `</div>
      <div class="i2p-section-content">` + contentEscaped + `</div>
    </div>`;
  }).join('');
  return { html, isStructured: true };
}

function renderResult(container, data) {
  const { title, ratio, description, tags, prompt_en } = data;
  
  const tagsHtml = (tags || []).map(t => `<div class="i2p-tag">${t}</div>`).join('');

  container.innerHTML = `
    <div class="i2p-header-label">IMAGETOPROMPT</div>
    <h2 class="i2p-title">${title || '无标题'}</h2>
    <div class="i2p-ratio">比例 ${ratio || '未知'}</div>
    <div class="i2p-desc" id="i2p-desc-area">${formatDescription(description).html}</div>
    
    <div class="i2p-json-container" id="i2p-json-area" style="display:none;"></div>
    
    <div class="i2p-tags" id="i2p-tags-area">${tagsHtml}</div>

    <!-- 裂变结果区域（初始隐藏） -->
    <div class="i2p-storyboard-panel" id="i2p-storyboard-panel" style="display:none;">
      <div class="i2p-storyboard-header">
        <span>🎬 NanoBananaPro 3×3 分镜</span>
        <button class="i2p-storyboard-copy" id="i2p-storyboard-copy">复制 JSON</button>
      </div>
      <div class="i2p-storyboard-shots" id="i2p-storyboard-shots"></div>
    </div>
    
    <div class="i2p-footer">
      <div class="i2p-lang-switch">
        <button class="i2p-lang-btn active" data-lang="zh">中</button>
        <button class="i2p-lang-btn" data-lang="en">EN</button>
        <button class="i2p-lang-btn" data-lang="json">J</button>
      </div>
      <div class="i2p-footer-actions">
        <button class="i2p-split-btn" id="i2p-split-btn">🎬 裂变</button>
        <button class="i2p-copy-btn" id="i2p-copy-btn">复制内容</button>
      </div>
    </div>
  `;

  // 各语言的显示内容
  const langContents = {
    zh: {
      desc: description || '',
      json: '',
      tags: tagsHtml
    },
    en: {
      desc: prompt_en || '',
      json: '',
      tags: ''
    },
    json: {
      desc: '',
      json: JSON.stringify(data, null, 2),
      tags: ''
    }
  };

  let currentLang = 'zh';
  let currentCopyText = description;

  const descArea = document.getElementById('i2p-desc-area');
  const jsonArea = document.getElementById('i2p-json-area');
  const tagsArea = document.getElementById('i2p-tags-area');

  const switchBtns = container.querySelectorAll('.i2p-lang-btn');
  switchBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      switchBtns.forEach(b => b.classList.remove('active'));
      const target = e.target;
      target.classList.add('active');
      
      currentLang = target.getAttribute('data-lang');
      const content = langContents[currentLang];

      // 结构化渲染：中文模式用 formatDescription 解析【】标记
      if (currentLang === 'zh') {
        descArea.innerHTML = formatDescription(content.desc).html;
      } else {
        descArea.textContent = content.desc;
      }
      jsonArea.innerHTML = content.json ? content.json.replace(/ /g, '&nbsp;').replace(/\n/g, '<br>') : '';
      jsonArea.style.display = content.json ? 'block' : 'none';
      tagsArea.innerHTML = content.tags;
      tagsArea.style.display = content.tags ? 'flex' : 'none';

      if (currentLang === 'zh') currentCopyText = data.description || '';
      if (currentLang === 'en') currentCopyText = data.prompt_en || '';
      if (currentLang === 'json') currentCopyText = JSON.stringify(data, null, 2);

      const copyBtn = document.getElementById('i2p-copy-btn');
      copyBtn.innerText = '复制内容';
      copyBtn.style.background = '#fff';
      copyBtn.style.color = '#000';
    });
  });

  // 复制按钮
  const copyBtn = document.getElementById('i2p-copy-btn');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(currentCopyText).then(() => {
      copyBtn.innerText = '已复制 √';
      copyBtn.style.background = '#28a745';
      copyBtn.style.color = '#fff';
      setTimeout(() => {
        copyBtn.innerText = '复制内容';
        copyBtn.style.background = '#fff';
        copyBtn.style.color = '#000';
      }, 2000);
    });
  });

  // ========== 裂变按钮逻辑 ==========
  const splitBtn = document.getElementById('i2p-split-btn');
  let storyboardData = null;

  splitBtn.addEventListener('click', () => {
    const panel = document.getElementById('i2p-storyboard-panel');
    const shotsContainer = document.getElementById('i2p-storyboard-shots');

    if (storyboardData) {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      return;
    }

    splitBtn.innerText = '⏳ 裂变中...';
    splitBtn.style.opacity = '0.6';
    splitBtn.style.pointerEvents = 'none';

    chrome.runtime.sendMessage({
      action: 'fetchStoryboard',
      promptEn: data.prompt_en || data.description || ''
    }, (response) => {
      splitBtn.style.opacity = '1';
      splitBtn.style.pointerEvents = 'auto';

      if (response && response.success && response.data) {
        storyboardData = response.data;
        splitBtn.innerText = '🎬 裂变 ✓';

        const shots = storyboardData.shots || [];
        shotsContainer.innerHTML = shots.map((shot, i) => `
          <div class="i2p-shot-card">
            <div class="i2p-shot-num">${shot.shot_number || ('分镜' + (i + 1))}</div>
            <div class="i2p-shot-text">${shot.prompt_text || ''}</div>
          </div>
        `).join('');

        panel.style.display = 'block';

        document.getElementById('i2p-storyboard-copy').addEventListener('click', () => {
          const fullJson = JSON.stringify(storyboardData, null, 2);
          navigator.clipboard.writeText(fullJson).then(() => {
            const btn = document.getElementById('i2p-storyboard-copy');
            btn.innerText = '已复制 √';
            btn.style.background = '#28a745';
            setTimeout(() => {
              btn.innerText = '复制 JSON';
              btn.style.background = 'rgba(255,255,255,0.15)';
            }, 2000);
          });
        });
      } else {
        splitBtn.innerText = '🎬 裂变';
        shotsContainer.innerHTML = `<div style="color:#ff6b6b;padding:12px;">裂变失败：${response?.error || '未知错误'}</div>`;
        panel.style.display = 'block';
      }
    });
  });
}
