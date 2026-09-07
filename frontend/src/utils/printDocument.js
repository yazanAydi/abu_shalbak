/**
 * Wait for images in a print document, then open the print dialog.
 * @param {Document} doc
 * @param {{ onAfterPrint?: () => void }} [opts]
 */
export function printDocumentWhenReady(doc, { onAfterPrint } = {}) {
  const win = doc.defaultView;
  if (!win) {
    onAfterPrint?.();
    return;
  }

  const triggerPrint = () => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onAfterPrint?.();
    };
    if (typeof win.addEventListener === "function") {
      win.addEventListener("afterprint", finish, { once: true });
    } else {
      win.onafterprint = finish;
    }
    try {
      const mq = win.matchMedia?.("print");
      if (mq && typeof mq.addEventListener === "function") {
        const onChange = (e) => {
          if (!e.matches) {
            mq.removeEventListener("change", onChange);
            finish();
          }
        };
        mq.addEventListener("change", onChange);
      }
    } catch {
      /* ignore */
    }
    win.focus();
    win.print();
    win.setTimeout(finish, 1500);
  };

  const images = Array.from(doc.images || []);
  if (images.length === 0) {
    triggerPrint();
    return;
  }

  let pending = 0;
  const finishOne = () => {
    pending -= 1;
    if (pending <= 0) triggerPrint();
  };

  for (const img of images) {
    if (img.complete) continue;
    pending += 1;
    img.addEventListener("load", finishOne, { once: true });
    img.addEventListener("error", finishOne, { once: true });
  }

  if (pending === 0) {
    triggerPrint();
  }
}
