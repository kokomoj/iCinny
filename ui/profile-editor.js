// Renderer logic for the profile editor. Talks to main only through the
// privilege-free window.profileEditor bridge (profile-preload.js).
'use strict';

let selectedColor = 'blue';
let mode = 'new';

const $ = (id) => document.getElementById(id);

function buildSwatches(colors) {
  const box = $('swatches');
  box.innerHTML = '';
  for (const c of colors) {
    const el = document.createElement('div');
    el.className = `swatch sw-${c}`;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-label', c);
    el.setAttribute('aria-selected', String(c === selectedColor));
    el.addEventListener('click', () => {
      selectedColor = c;
      for (const s of box.children) s.setAttribute('aria-selected', String(s === el));
    });
    box.appendChild(el);
  }
}

window.profileEditor.onInit((data) => {
  mode = data.mode;
  selectedColor = data.color || 'blue';
  $('heading').textContent = mode === 'new' ? 'New Profile' : 'Edit Profile';
  $('save').textContent = mode === 'new' ? 'Create' : 'Save';
  $('name').value = data.name || '';
  $('openAtLaunch').checked = !!data.openAtLaunch;
  buildSwatches(data.colors || ['blue']);

  // The default profile's name can be edited but it never auto-opens itself.
  if (mode === 'edit' && data.isDefault) {
    const row = $('openAtLaunch').closest('.row');
    if (row) row.style.display = 'none';
  }
  $('name').focus();
});

async function doSave() {
  const name = $('name').value.trim();
  $('err').textContent = '';
  if (mode === 'new' && !name) {
    $('err').textContent = 'Please enter a name.';
    $('name').focus();
    return;
  }
  $('save').disabled = true;
  try {
    const res = await window.profileEditor.save({
      mode,
      name,
      color: selectedColor,
      openAtLaunch: $('openAtLaunch').checked,
    });
    if (res && res.ok) {
      window.profileEditor.cancel(); // closes the window
    } else {
      $('err').textContent = (res && res.error) || 'Could not save.';
      $('save').disabled = false;
    }
  } catch (e) {
    $('err').textContent = 'Could not save.';
    $('save').disabled = false;
  }
}

$('save').addEventListener('click', doSave);
$('cancel').addEventListener('click', () => window.profileEditor.cancel());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSave();
  if (e.key === 'Escape') window.profileEditor.cancel();
});
