let activeProject = null;
let collapsedGroups = JSON.parse(localStorage.getItem('maidbot_collapsed_groups') || '[]');
let chatHistory = [];
let currentProjectsData = null; 
let loadToken = 0;

marked.setOptions({ breaks: true });

function loadHistory() {
  const saved = localStorage.getItem(`maidbot_history_${activeProject ? activeProject.project_name : 'default'}`);
  chatHistory = saved ? JSON.parse(saved) : [];
  renderChatBox();
}

function saveHistory() {
  if (activeProject) {
    localStorage.setItem(`maidbot_history_${activeProject.project_name}`, JSON.stringify(chatHistory));
  }
}

function clearHistory() {
  if(!confirm('确定清空当前前端的对话显示吗？（不会影响黑板和云端记忆）')) return;
  chatHistory = [];
  saveHistory();
  renderChatBox();
}

function renderChatBox() {
  const box = document.getElementById('chat-box');
  box.innerHTML = '';
  
  if (chatHistory.length === 0) {
    box.innerHTML = '<div class="msg ai"><div class="msg-content">欢迎使用。请先锁定一个项目，然后输入需求。</div></div>';
    return;
  }

  chatHistory.forEach(msg => {
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${msg.role}`;
    if (msg.role === 'user') {
      // 🆕 用户发送的长文本，替换换行符为 <br>，或依赖 CSS 的 white-space: pre-wrap
      const safeContent = msg.content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      msgDiv.innerHTML = `<div class="msg-content">${safeContent}</div>`;
    } else {
      const html = marked.parse(msg.content);
      msgDiv.innerHTML = `<div class="msg-content">${html}</div>` + 
                         (msg.meta ? `<div class="msg-meta">${msg.meta}</div>` : '');
    }
    box.appendChild(msgDiv);
  });
  
  if (typeof hljs !== 'undefined') {
    document.querySelectorAll('.msg.ai pre code').forEach((el) => {
      hljs.highlightElement(el);
    });
  }

  document.querySelectorAll('.msg.ai pre').forEach(pre => {
    if(!pre.querySelector('.copy-btn')){
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.innerText = '复制';
      btn.onclick = () => {
        const code = pre.querySelector('code').innerText;
        copyTextToClipboard(code, btn);
      };
      pre.appendChild(btn);
    }
  });
  
  box.scrollTop = box.scrollHeight;
}

function copyTextToClipboard(text, btnElement) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => showCopySuccess(btnElement)).catch(() => fallbackCopy(text, btnElement));
  } else {
    fallbackCopy(text, btnElement);
  }
}

function fallbackCopy(text, btnElement) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    const successful = document.execCommand('copy');
    if (successful) showCopySuccess(btnElement);
    else btnElement.innerText = '复制失败';
  } catch (err) {
    btnElement.innerText = '复制失败';
  }
  document.body.removeChild(textArea);
}

function showCopySuccess(btn) {
  btn.innerText = '已复制!';
  setTimeout(() => btn.innerText = '复制', 2000);
}

function renderProjects(data) {
  if (!data.success || !data.projects) return;
  currentProjectsData = data; 

  const treeEl = document.getElementById('project-tree');
  const groups = {};
  const prevActive = activeProject ? activeProject.project_name : null;
  activeProject = null;

  const sortedProjects = [...data.projects].sort((a, b) => b.updated_at - a.updated_at);
  
  sortedProjects.forEach(p => {
    const g = p.group_name || 'common';
    if (!groups[g]) groups[g] = [];
    groups[g].push(p);
    if (p.is_active === 1 && !activeProject) {
      activeProject = p;
    }
  });

  let htmlStr = '';
  const sortedGroupNames = Object.keys(groups).sort((a, b) => {
    if (a === 'common') return -1;
    if (b === 'common') return 1;
    return a.localeCompare(b);
  });

  for (const groupName of sortedGroupNames) {
    const projects = groups[groupName];
    const isCollapsed = collapsedGroups.includes(groupName);
    const boxClass = isCollapsed ? 'group-box collapsed' : 'group-box';
    const isCommon = groupName === 'common';

    const icon = isCommon ? '🌍' : '🔒';
    const titleColor = isCommon ? '#10b981' : '#f59e0b';
    const badgeHtml = isCommon 
      ? '<span style="font-size:10px; background:#064e3b; color:#10b981; padding:2px 6px; border-radius:4px; margin-left:8px; border:1px solid #10b981;">全员共享</span>'
      : '<span style="font-size:10px; background:#451a03; color:#f59e0b; padding:2px 6px; border-radius:4px; margin-left:8px; border:1px solid #f59e0b;">内部隔离</span>';

    htmlStr += `<div class="${boxClass}" ondrop="drop(event, '${groupName}')" ondragover="allowDrop(event)" ondragleave="dragLeave(event)">`;
    htmlStr += `<div class="group-header" onclick="toggleGroup('${groupName}')">`;
    htmlStr += `<div class="group-header-left">`;
    htmlStr += `<span class="group-icon">▼</span>`;
    htmlStr += `<span style="color: ${titleColor};">${icon} ${groupName}</span>`;
    htmlStr += badgeHtml;
    htmlStr += `</div>`;
    if (!isCommon) {
       htmlStr += `<span class="actions" onclick="event.stopPropagation(); deleteGroup('${groupName}')" title="删除整组">🗑️</span>`;
    } else {
       htmlStr += `<span style="width: 24px;"></span>`;
    }
    htmlStr += `</div>`;
    
    htmlStr += `<div class="group-content">`;
    projects.forEach(p => {
      const statusClass = p.is_active ? 'active' : (p.status === 'completed' ? 'completed' : '');
      const badge = p.is_active ? '<span class="status-badge locked">🔒 开发中</span>' : (p.status === 'completed' ? '<span class="status-badge">✅ 归档</span>' : '<span class="status-badge">⏸️ 休眠</span>');
      
      htmlStr += `<div class="project-item ${statusClass}" draggable="true" ondragstart="drag(event, '${groupName}', '${p.project_name}')" onclick="switchProject('${groupName}/${p.project_name}')">`;
      htmlStr += `<span>${p.project_name}</span>`;
      htmlStr += `<div style="display:flex; gap:8px; align-items:center;">${badge}`;
      htmlStr += `<span onclick="event.stopPropagation(); deleteProject('${groupName}', '${p.project_name}')" style="cursor:pointer; opacity:0.5; padding:4px;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5">🗑️</span>`;
      htmlStr += `</div></div>`;
    });
    htmlStr += `</div></div>`;
  }
  treeEl.innerHTML = htmlStr;
  
  const bar = document.getElementById('blackboard-bar');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  
  if (activeProject) {
    bar.style.display = 'flex';
    document.getElementById('current-project-name').innerText = activeProject.project_name;
    document.getElementById('code-length').innerText = activeProject.code_len || 0;
    input.disabled = false; sendBtn.disabled = false;
    input.placeholder = `正在开发 [${activeProject.project_name}]...`;
    
    if (prevActive !== activeProject.project_name) {
      loadHistory();
    }
  } else {
    bar.style.display = 'none';
    input.disabled = true; sendBtn.disabled = true;
    input.placeholder = '请先在左侧选择或创建项目组';
    chatHistory = [];
    renderChatBox();
  }
}

async function loadProjects() {
  const myToken = ++loadToken;
  try {
    const res = await fetch('/api/dev/projects?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    
    if (myToken !== loadToken) return;
    renderProjects(data);
  } catch (e) {
    if (myToken !== loadToken) return;
    document.getElementById('project-tree').innerHTML = `<div style="color:#ef4444;padding:12px;font-size:12px;">加载失败: ${e.message}</div>`;
  }
}

function toggleGroup(groupName) {
  if (collapsedGroups.includes(groupName)) {
    collapsedGroups = collapsedGroups.filter(g => g !== groupName);
  } else {
    collapsedGroups.push(groupName);
  }
  localStorage.setItem('maidbot_collapsed_groups', JSON.stringify(collapsedGroups));
  if (currentProjectsData) renderProjects(currentProjectsData);
}

function showStatus() {
  if (!activeProject) return;
  const statusMsg = `📊 **当前状态概览**\n\n- 当前锁定项目: \`${activeProject.project_name}\`\n- 所属组: \`${activeProject.group_name}\`\n- 项目状态: ${activeProject.status === 'active' ? '开发中' : '已归档'}\n- 黑板代码量: ${activeProject.code_len || 0} 字符`;
  chatHistory.push({ role: 'ai', content: statusMsg });
  saveHistory();
  renderChatBox();
}

function addNote() {
  if (!activeProject) return alert('请先锁定一个项目');
  const note = prompt("请输入你想沉淀的开发笔记、踩坑记录或架构决策：\n（留空则取消）");
  if (note && note.trim()) {
    document.getElementById('input').value = `/dev note ${note.trim()}`;
    send();
  }
}

function createProject() {
  const group = document.getElementById('new-group').value.trim() || 'common';
  const project = document.getElementById('new-project').value.trim();
  if (!project) return alert('请输入项目名');
  
  document.getElementById('input').value = `/dev use ${group}/${project}`;
  document.getElementById('new-project').value = '';
  send();
}

function switchProject(path) {
  const groupName = path.split('/')[0] || 'common';
  const projectName = path.split('/')[1] || path;

  if (currentProjectsData && currentProjectsData.projects) {
    currentProjectsData.projects.forEach(p => {
      p.is_active = (p.group_name === groupName && p.project_name === projectName) ? 1 : 0;
    });
    renderProjects(currentProjectsData);
  }

  const input = document.getElementById('input');
  input.value = `/dev use ${path}`;
  send();
}

function archiveProject() {
  if (!activeProject) return;
  if(!confirm(`确定归档项目 [${activeProject.project_name}] 吗？将清空黑板并触发蒸馏。`)) return;
  document.getElementById('input').value = `/dev done`;
  send();
}

async function deleteProject(group, project) {
  if (!confirm(`确定删除项目 [${project}] 吗？相关黑板记录将丢失。`)) return;
  try {
    const res = await fetch(`/api/dev/projects/${encodeURIComponent(group)}/${encodeURIComponent(project)}`, { method: 'DELETE' });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || '未知错误'); }
    loadProjects();
  } catch (e) { alert('删除失败: ' + e.message); }
}

async function deleteGroup(group) {
  if (group === 'common') return alert('🛑 公共池默认组不可删除！');
  if (!confirm(`⚠️ 确定删除整个项目组 [${group}] 吗？`)) return;
  try {
    const res = await fetch(`/api/dev/groups/${encodeURIComponent(group)}`, { method: 'DELETE' });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || '未知错误'); }
    loadProjects();
  } catch (e) { alert('删除失败: ' + e.message); }
}

function allowDrop(ev) { ev.preventDefault(); ev.currentTarget.classList.add('drag-over'); }
function dragLeave(ev) { ev.currentTarget.classList.remove('drag-over'); }
function drag(ev, group, project) { ev.dataTransfer.setData("text/plain", JSON.stringify({ group: group, project: project })); }

async function drop(ev, targetGroup) {
  ev.preventDefault();
  ev.currentTarget.classList.remove('drag-over');
  const data = JSON.parse(ev.dataTransfer.getData("text/plain"));
  if (data.group === targetGroup) return;
  try {
    const res = await fetch('/api/dev/projects/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldGroup: data.group, project: data.project, newGroup: targetGroup })
    });
    if (!res.ok) throw new Error('移动失败');
    loadProjects();
  } catch (e) { alert('移动失败: ' + e.message); }
}

async function send() {
  const input = document.getElementById('input');
  const btn = document.getElementById('send');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto'; // 🆕 发送后重置高度
  btn.disabled = true;

  chatHistory.push({ role: 'user', content: text });
  saveHistory();
  renderChatBox();

  const tempAiIndex = chatHistory.length;
  chatHistory.push({ role: 'ai', content: '思考中...', meta: '' });
  renderChatBox();

  try {
    const res = await fetch('/api/dev/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text })
    });
    
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    
    if (data.success) {
      chatHistory[tempAiIndex] = { 
        role: 'ai', 
        content: data.reply, 
        meta: `生成: ${data.provider} | 审查: ${data.reviewer} | 耗时: ${(data.latency/1000).toFixed(1)}s`
      };
      
      if (data.projects) {
         renderProjects({ success: true, projects: data.projects });
      } else {
         await loadProjects();
      }
    } else {
      chatHistory[tempAiIndex] = { role: 'ai', content: `**后端错误:** ${data.error}` };
      await loadProjects();
    }
  } catch (e) {
    chatHistory[tempAiIndex] = { role: 'ai', content: `**请求异常:** ${e.message}` };
    await loadProjects();
  } finally {
    saveHistory();
    renderChatBox();
    btn.disabled = false; 
    input.focus();
  }
}

// 🆕 核心改造：Shift + Enter 换行，Enter 发送，并支持自适应高度
const inputEl = document.getElementById('input');
inputEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); // 阻止默认的回车换行行为
    send();
  }
});

// 🆕 输入时自动扩展高度，最大 200px，超出后出现滚动条
inputEl.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = (this.scrollHeight) + 'px';
  if (this.scrollHeight > 200) {
    this.style.height = '200px';
  }
});

document.getElementById('send').addEventListener('click', send);

loadProjects();
