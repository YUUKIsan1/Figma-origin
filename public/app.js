const $ = (id) => document.getElementById(id);
let selectedFile = null,
  selectedPage = null,
  selectedFrame = null,
  currentVersion = null;
let navigation = 0;
let fitMode = false;
function showLogin() {
  ++navigation; // Invalidate responses that were started before logout/session expiry.
  selectedFile = selectedPage = selectedFrame = currentVersion = null;
  fitMode = false;
  $('viewer').hidden = true;
  $('login').hidden = false;
  $('logout').hidden = true;
  $('preview').removeAttribute('src');
  $('password').value = '';
  $('status').textContent = '';
}
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (response.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('ログインしてください');
  }
  if (!response.ok)
    throw new Error(typeof result.error === 'string' ? result.error : 'リクエストに失敗しました');
  return result;
}
function report(error) {
  $('status').textContent = error.message;
}
function action(fn) {
  return () => {
    $('status').textContent = '';
    Promise.resolve().then(fn).catch(report);
  };
}
function breadcrumb() {
  $('breadcrumb').replaceChildren();
  const items = [
    [
      'ファイル一覧',
      () => {
        selectedFile = null;
        selectedPage = null;
        selectedFrame = null;
        return load();
      },
    ],
  ];
  if (selectedFile)
    items.push([
      selectedFile.name,
      () => {
        selectedPage = null;
        selectedFrame = null;
        return load();
      },
    ]);
  if (selectedPage)
    items.push([
      selectedPage.name,
      () => {
        selectedFrame = null;
        return load();
      },
    ]);
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = action(fn);
    $('breadcrumb').append(b);
  }
}
function card(title, subtitle, icon, onClick) {
  const button = document.createElement('button');
  button.className = 'card';
  for (const [tag, text, cls] of [
    ['span', icon, 'icon'],
    ['strong', title, ''],
    ['small', subtitle, ''],
  ]) {
    const el = document.createElement(tag);
    el.textContent = text;
    el.className = cls;
    button.append(el);
  }
  button.onclick = action(onClick);
  return button;
}
async function load() {
  const ticket = ++navigation;
  const data = selectedFile ? await api(`/api/files/${selectedFile.id}`) : await api('/api/files');
  if (ticket !== navigation) return;
  $('login').hidden = true;
  $('viewer').hidden = false;
  $('logout').hidden = false;
  $('status').textContent = '';
  $('list').replaceChildren();
  $('frame-view').hidden = true;
  $('list').hidden = false;
  if (!selectedFile) {
    $('title').textContent = 'デザインファイル';
    data.forEach((f) =>
      $('list').append(
        card(f.name, `Version ${f.version}`, '▧', () => {
          selectedFile = f;
          return load();
        }),
      ),
    );
  } else {
    selectedFile = data.file;
    currentVersion = data.version;
    if (selectedPage)
      selectedPage = selectedFile.pages.find((p) => p.id === selectedPage.id) ?? null;
    if (selectedFrame)
      selectedFrame = selectedPage?.frames.find((f) => f.id === selectedFrame.id) ?? null;
    if (!selectedPage) {
      $('title').textContent = selectedFile.name;
      selectedFile.pages.forEach((p) =>
        $('list').append(
          card(p.name, `${p.frames.length} フレーム`, '▤', () => {
            selectedPage = p;
            return load();
          }),
        ),
      );
    } else if (!selectedFrame) {
      $('title').textContent = selectedPage.name;
      selectedPage.frames.forEach((f) =>
        $('list').append(
          card(f.name, `${f.width} × ${f.height}`, f.width < 600 ? '▯' : '▭', () => {
            selectedFrame = f;
            return load().then(fit);
          }),
        ),
      );
    } else {
      $('title').textContent = selectedFrame.name;
      $('list').hidden = true;
      $('frame-view').hidden = false;
      $('frames').replaceChildren();
      selectedPage.frames.forEach((f) => {
        const option = document.createElement('option');
        option.value = f.id;
        option.textContent = `${f.name} (${f.width}×${f.height})`;
        option.selected = f.id === selectedFrame.id;
        $('frames').append(option);
      });
      $('preview').width = selectedFrame.width;
      $('preview').height = selectedFrame.height;
      $('preview').src = `/preview/${selectedFile.id}/${selectedFrame.id}?v=${currentVersion}`;
      if (fitMode) fit();
      else zoom();
    }
  }
  if (!$('list').hidden && !$('list').children.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'まだデザインがありません。MCPから画面を追加すると、ここに表示されます。';
    $('list').append(empty);
  }
  breadcrumb();
}
function zoom() {
  if (!selectedFrame) return;
  const value = Number($('zoom').value);
  $('preview').style.transform = `scale(${value / 100})`;
  $('frame-space').style.width = `${(selectedFrame.width * value) / 100}px`;
  $('frame-space').style.height = `${(selectedFrame.height * value) / 100}px`;
  $('zoom-value').value = `${value}%`;
}
function fit() {
  if (!selectedFrame || $('frame-view').hidden) return;
  const stage = $('stage');
  const style = window.getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height =
    stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const scale = Math.min(1, width / selectedFrame.width, height / selectedFrame.height);
  $('zoom').value = Math.max(1, Math.floor(scale * 100));
  fitMode = true;
  zoom();
  stage.scrollLeft = stage.scrollTop = 0;
}
$('login-form').onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    await api('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    $('password').value = '';
    await load();
  })();
};
$('logout').onclick = action(async () => {
  await api('/logout', { method: 'POST' });
  showLogin();
});
$('refresh').onclick = action(load);
$('fit').onclick = fit;
$('zoom').oninput = () => {
  fitMode = false;
  zoom();
};
window.addEventListener('resize', () => {
  if (fitMode) fit();
});
$('frames').onchange = action(async () => {
  selectedFrame = selectedPage.frames.find((f) => f.id === $('frames').value);
  await load();
  fit();
});
window.setInterval(() => {
  if (document.hidden || $('viewer').hidden) return;
  if (selectedFile) {
    const fileId = selectedFile.id;
    const version = currentVersion;
    const ticket = navigation;
    api(`/api/files/${fileId}`)
      .then((data) => {
        if (ticket === navigation && version !== data.version) return load();
      })
      .catch(report);
  } else load().catch(report);
}, 10000);
load().catch((error) => {
  if (error.message !== 'ログインしてください') report(error);
});
