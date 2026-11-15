const $ = (id) => document.getElementById(id);

async function refresh() {
  const dir = await getSaveDir();
  $('current').textContent = dir ? dir.name : 'none chosen';
  $('reauth').hidden = !dir;
  $('perm').textContent = dir
    ? 'Access: ' + ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'allowed' : 'needs to be re-allowed')
    : '';
}

$('choose').onclick = async () => {
  $('msg').textContent = '';
  try {
    const dir = await showDirectoryPicker({ id: 'recorder-save', mode: 'readwrite', startIn: 'videos' });
    await setSaveDir(dir);
  } catch (err) {
    if (err.name !== 'AbortError') $('msg').textContent = err.message; // AbortError = user cancelled
  }
  refresh();
};

$('reauth').onclick = async () => {
  const dir = await getSaveDir();
  if (dir) await dir.requestPermission({ mode: 'readwrite' });
  refresh();
};

refresh();
