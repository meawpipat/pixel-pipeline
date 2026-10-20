// Small modal helpers on native <dialog> elements (template.html).

/** Confirm dialog; resolves true/false. */
export function askConfirm($, message, okLabel = 'Confirm') {
  const dlg = $('confirmDlg');
  $('confirmMsg').textContent = message;
  $('confirmOk').textContent = okLabel;
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); $('confirmOk').onclick = $('confirmCancel').onclick = null; dlg.oncancel = null; resolve(v); };
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
  });
}

/** Choice dialog; options = [[value, label], …]; the last option is the default/cancel. Resolves the value. */
export function choose($, message, options) {
  const dlg = $('choiceDlg');
  $('choiceMsg').textContent = message;
  const box = $('choiceBtns');
  box.innerHTML = '';
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); dlg.oncancel = null; resolve(v); };
    options.forEach(([v, label], i) => {
      const b = document.createElement('button');
      b.className = 'btn' + (i === 0 ? ' primary' : '');
      b.textContent = label;
      b.dataset.value = v;
      b.onclick = () => done(v);
      box.append(b);
    });
    dlg.oncancel = (e) => { e.preventDefault(); done(options[options.length - 1][0]); };
    dlg.showModal();
  });
}
