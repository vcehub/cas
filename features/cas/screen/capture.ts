// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 VCE Hub. Part of the /cas calculator: https://github.com/vcehub/cas
/**
 * A picture of the calculator screen, for teachers' worked solutions. The
 * screen's DOM is copied with every element's computed style written inline,
 * the graph canvas swapped for an image of itself, and the copy drawn into an
 * SVG foreignObject at `scale`× its size, so the PNG stays sharp in print.
 * The copy keeps the history scrolled where it is on screen. A history line
 * wider than the screen, which the screen cuts off, is shrunk to fit, so
 * the picture shows all of it. The blinking cursor is left out.
 */
export async function screenPng(el: HTMLElement, scale = 3): Promise<Blob> {
  const { width: w, height: h } = el.getBoundingClientRect();
  const clone = el.cloneNode(true) as HTMLElement;
  inlineStyles(el, clone);
  for (const caret of clone.querySelectorAll('[class*="animate-casblink"]')) caret.remove();

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml">${new XMLSerializer().serializeToString(clone)}</div>` +
    `</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No canvas");
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No image"))), "image/png"),
  );
}

/** Copy computed styles onto the clone, element by element; canvases become images. */
function inlineStyles(src: Element, dst: Element) {
  if (src instanceof HTMLCanvasElement && dst instanceof HTMLCanvasElement) {
    const img = document.createElement("img");
    img.src = src.toDataURL("image/png");
    const cs = getComputedStyle(src);
    img.setAttribute("style", `position:${cs.position};inset:0;width:${cs.width};height:${cs.height}`);
    dst.replaceWith(img);
    return;
  }
  const cs = getComputedStyle(src);
  let css = "";
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i]!;
    css += `${p}:${cs.getPropertyValue(p)};`;
  }
  dst.setAttribute("style", css);
  const a = Array.from(src.children);
  const b = Array.from(dst.children);
  a.forEach((child, i) => {
    if (b[i]) inlineStyles(child, b[i]!);
  });
  // A clone isn't scrolled, so shift its contents by the scroll instead.
  if (src.scrollTop || src.scrollLeft) {
    b.forEach((child, i) => {
      const t = getComputedStyle(a[i]!).transform;
      const shift = `translate(${-src.scrollLeft}px,${-src.scrollTop}px)`;
      child.setAttribute("style", `${child.getAttribute("style")}transform:${shift}${t === "none" ? "" : ` ${t}`};`);
    });
  }
  if (src instanceof HTMLElement && src.dataset.casFit !== undefined) fitLines(src, dst);
}

/** Shrink a history band's lines that are wider than the band, keeping their left edge. */
function fitLines(src: HTMLElement, dst: Element) {
  const cs = getComputedStyle(src);
  const room = src.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const lines = ":scope > .font-casmath, :scope > span > .font-casmath";
  const b = dst.querySelectorAll(lines);
  src.querySelectorAll<HTMLElement>(lines).forEach((line, i) => {
    const k = room / line.scrollWidth;
    if (k < 1 && b[i]) b[i]!.setAttribute("style", `${b[i]!.getAttribute("style")}transform:scale(${k});transform-origin:0 50%;`);
  });
}

/** Save a blob as a file. */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
