(function () {
  if (window.__cpLoaded) return; window.__cpLoaded = true;
  var css = '#cp-btn{background:transparent;border:1px solid #334155;color:#94a3b8;padding:5px 12px;border-radius:6px;font-size:12px;cursor:pointer;transition:.2s;margin-left:12px}' +
    '#cp-btn:hover{border-color:#10b981;color:#10b981}' +
    '#cp-btn.cp-warn{border-color:#f59e0b;color:#f59e0b}' +
    '#cp-mask{position:fixed;inset:0;background:rgba(2,6,23,.72);z-index:9999;display:none}#cp-mask.open{display:block}' +
    '#cp-box{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(760px,92vw);max-height:86vh;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:10px;z-index:10000;display:none;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.6)}' +
    '#cp-box.open{display:flex}' +
    '#cp-hd{padding:14px 18px;border-bottom:1px solid #334155;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:14px}' +
    '#cp-hd small{color:#64748b;font-weight:400;margin-left:8px;font-size:12px}' +
    '#cp-body{padding:16px 18px;overflow:auto;flex:1}' +
    '#cp-text{width:100%;height:250px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:12px;font-family:ui-monospace,monospace;font-size:13px;line-height:1.7;resize:vertical;outline:none}' +
    '#cp-text:focus{border-color:#10b981}' +
    '#cp-reason{width:100%;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:9px 12px;margin-top:10px;font-size:13px;outline:none}' +
    '#cp-hint{color:#64748b;font-size:11px;margin-top:8px}' +
    '#cp-ft{padding:12px 18px;border-top:1px solid #334155;display:flex;justify-content:flex-end;gap:10px}' +
    '.cp-b{border:0;border-radius:6px;padding:9px 20px;cursor:pointer;font-size:13px}' +
    '#cp-save{background:#10b981;color:#0f172a;font-weight:bold}#cp-cancel{background:#334155;color:#cbd5e1}' +
    '#cp-tip{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:10001;background:#10b981;color:#0f172a;padding:10px 18px;border-radius:8px;display:none;font-size:13px;font-weight:600}' +
    '#cp-tip.err{background:#ef4444;color:#fff}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var hd = document.querySelector('header');
  var btn = document.createElement('button'); btn.id = 'cp-btn'; btn.textContent = '📜 宪法';
  if (hd) hd.appendChild(btn); else document.body.appendChild(btn);
  var mask = document.createElement('div'); mask.id = 'cp-mask';
  var box = document.createElement('div'); box.id = 'cp-box';
  box.innerHTML = '<div id="cp-hd"><span>📜 项目宪法 <small id="cp-which"></small></span><span id="cp-x" style="cursor:pointer;color:#64748b">✕</span></div>' +
    '<div id="cp-body"><textarea id="cp-text" spellcheck="false" placeholder="写下项目的最高约束：核心目标、禁止项、技术栈红线…"></textarea>' +
    '<input id="cp-reason" placeholder="修改原因（写入历史留痕，AI 只有建议权，你才有修改权）"/>' +
    '<div id="cp-hint">保存后立即生效：下一轮对话的 system prompt 会强制内置这段宪法。</div></div>' +
    '<div id="cp-ft"><button class="cp-b" id="cp-cancel">取消</button><button class="cp-b" id="cp-save">保存并生效</button></div>';
  var tip = document.createElement('div'); tip.id = 'cp-tip';
  [mask, box, tip].forEach(function (el) { document.body.appendChild(el); });
  var st2 = document.createElement('style');
  st2.textContent = '.cp-lb{color:#cbd5e1;font-size:12px;font-weight:700;margin:2px 0 6px}.cp-sub{color:#64748b;font-weight:400;margin-left:6px}';
  document.head.appendChild(st2);
  var dirty = false, serverText = '';
  var ta = document.getElementById('cp-text'), rs = document.getElementById('cp-reason');
  var body = document.getElementById('cp-body'), hintEl = document.getElementById('cp-hint');
  var l1 = document.createElement('div'); l1.className = 'cp-lb'; l1.innerHTML = '① 宪法正文 <span class="cp-sub">—— 改这里，保存后立即生效</span>';
  var l2 = document.createElement('div'); l2.className = 'cp-lb'; l2.style.marginTop = '16px'; l2.innerHTML = '② 修改原因 <span class="cp-sub">—— 选填一句话，只进历史日志，不影响宪法</span>';
  body.insertBefore(l1, ta); body.insertBefore(l2, rs);
  rs.style.width = '62%'; rs.style.marginTop = '0';
  function hint() { hintEl.textContent = '服务器当前 ' + serverText.trim().length + ' 字 · ① 里现在有 ' + ta.value.trim().length + ' 字' + (ta.value.trim() === serverText.trim() ? '（还没改）' : '（改过了，可以保存）'); }
  ta.addEventListener('input', function () { dirty = true; hint(); });
  function say(m, ok) { tip.textContent = m; tip.className = ok ? '' : 'err'; tip.style.display = 'block'; clearTimeout(tip._t); tip._t = setTimeout(function () { tip.style.display = 'none'; }, 3000); }
  function fill(d) {
    document.getElementById('cp-which').textContent = (d && d.success) ? '【' + d.group + '/' + d.project + '】' : '';
    serverText = (d && d.constitution) || '';
    if (!dirty) ta.value = serverText;
    if (d && d.success && !serverText) { btn.textContent = '⚠️ 宪法未设置'; btn.className = 'cp-warn'; }
    else if (d && d.success) { btn.textContent = '📜 宪法'; btn.className = ''; }
    hint();
  }
  function load() { return fetch('/api/dev/constitution').then(function (r) { return r.json(); }).then(function (d) { fill(d); return d; }); }
  function open() { dirty = false; mask.classList.add('open'); box.classList.add('open'); load().then(function (d) { if (d && !d.success) say(d.error || '请先锁定项目', 0); }).catch(function () { say('接口读取失败', 0); }); }
  function close() { mask.classList.remove('open'); box.classList.remove('open'); }
  btn.onclick = open; mask.onclick = close;
  document.getElementById('cp-x').onclick = close; document.getElementById('cp-cancel').onclick = close;
  document.getElementById('cp-save').onclick = function () {
    var t = ta.value.trim(), why = rs.value.trim();
    if (!t) return say('① 宪法正文不能为空', 0);
    if (t === serverText.trim()) return say('① 里还没有改动，保存的内容与当前宪法一致', 0);
    fetch('/api/dev/constitution', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newConstitution: t, reason: why || '用户手动修改' }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.success) return say('❌ ' + (d.error || '保存失败'), 0);
        serverText = t; dirty = false; rs.value = ''; ta.value = t; hint();
        btn.textContent = '📜 宪法'; btn.className = '';
        say('✅ 已提交 ' + t.length + ' 字，保存成功', 1);
        setTimeout(close, 1200);
      })
      .catch(function () { say('保存请求失败', 0); });
  };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  load().catch(function () {});
})();
