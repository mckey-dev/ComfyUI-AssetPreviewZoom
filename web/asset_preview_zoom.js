/**
 * ComfyUI Asset Preview Zoom
 *
 * アセットプレビュー（ライトボックス）の画像に、ホイールズームとドラッグパンを
 * 追加するフロントエンド拡張。ノードは追加しない。
 *
 * 拡大率は 1x〜10x。1x はプレビュー欄に収めた全体表示。
 * 欄より大きい画像は縮小して収め、小さい画像は実寸のままにする。
 * ダブルクリックで拡大率と位置をリセットする。
 */
import { app } from "../../scripts/app.js";

const STYLE_ID = "comfyui-asset-preview-zoom-style";
const MIN_SCALE = 1;
const MAX_SCALE = 10;
const PANE_FIT = 0.9;
const states = new WeakMap();

/** ズーム操作用の CSS を document.head に一度だけ挿入する。 */
function injectStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [data-asset-zoom-host] {
      overflow: hidden;
    }
    [data-asset-zoom] {
      cursor: grab;
      transform-origin: center center;
      will-change: transform;
      touch-action: none;
      user-select: none;
    }
    [data-asset-zoom][data-asset-zoom-dragging] {
      cursor: grabbing;
    }
  `;
  document.head.appendChild(style);
}

/**
 * ノードがアセットプレビューのライトボックスかどうかを返す。
 * @param {Node} node
 * @returns {boolean}
 */
function isLightbox(node) {
  return (
    node instanceof HTMLElement &&
    node.getAttribute("role") === "dialog" &&
    node.getAttribute("aria-modal") === "true" &&
    node.hasAttribute("data-mask")
  );
}

/**
 * ノード自身と子孫からライトボックス要素を集める。
 * @param {Node} node
 * @returns {HTMLElement[]}
 */
function findLightboxes(node) {
  if (!(node instanceof HTMLElement)) {
    return [];
  }
  const found = [];
  if (isLightbox(node)) {
    found.push(node);
  }
  found.push(
    ...node.querySelectorAll('[role="dialog"][aria-modal="true"][data-mask]')
  );
  return found;
}

/**
 * 拡大率を MIN_SCALE〜MAX_SCALE に収める。
 * @param {number} scale
 * @returns {number}
 */
function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 画像をプレビュー欄に収める。欄より大きいときは縮小し、小さいときは実寸のまま。
 * 1x のレイアウトサイズになる。拡大はこのサイズに対する倍率。
 * @param {HTMLElement} dialog
 * @param {HTMLImageElement} img
 */
function fitImageToPane(dialog, img) {
  const width = dialog.clientWidth * PANE_FIT;
  const height = dialog.clientHeight * PANE_FIT;
  if (width <= 0 || height <= 0) {
    return;
  }
  img.style.maxWidth = `${width}px`;
  img.style.maxHeight = `${height}px`;
  img.style.width = "auto";
  img.style.height = "auto";
  img.style.objectFit = "contain";
}

/**
 * fitImageToPane で付けた表示サイズ指定を外す。
 * @param {HTMLImageElement} img
 */
function clearFitStyles(img) {
  img.style.maxWidth = "";
  img.style.maxHeight = "";
  img.style.width = "";
  img.style.height = "";
  img.style.objectFit = "";
}

/**
 * state の scale / pan を画像の CSS transform に反映する。
 * @param {object} state
 */
function applyTransform(state) {
  if (!state.img) {
    return;
  }
  state.img.style.transform = `matrix(${state.scale},0,0,${state.scale},${state.panX},${state.panY})`;
}

/**
 * 拡大率とパン位置を初期値に戻す。
 * @param {object} state
 */
function resetTransform(state) {
  state.scale = 1;
  state.panX = 0;
  state.panY = 0;
  applyTransform(state);
}

/**
 * パンを除いた画像のレイアウト中心（画面座標）を返す。
 * カーソル位置を基準にズームするときの原点に使う。
 * @param {object} state
 * @returns {{x: number, y: number}}
 */
function layoutCenter(state) {
  const rect = state.img.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - state.panX,
    y: rect.top + rect.height / 2 - state.panY,
  };
}

/**
 * ホイールでカーソル位置を中心にズームする。
 * @param {HTMLElement} dialog
 * @param {WheelEvent} event
 */
function onWheel(dialog, event) {
  const state = states.get(dialog);
  if (!state?.img) {
    return;
  }
  event.preventDefault();

  const nextScale = clampScale(state.scale * 1.1 ** (event.deltaY / -30));
  const factor = nextScale / state.scale;
  if (factor === 1) {
    return;
  }

  const center = layoutCenter(state);
  state.panX = state.panX * factor - (event.clientX - center.x) * (factor - 1);
  state.panY = state.panY * factor - (event.clientY - center.y) * (factor - 1);
  state.scale = nextScale;
  applyTransform(state);
}

/**
 * 画像からズーム操作用のイベントと属性を外す。
 * @param {object} state
 */
function unbindImage(state) {
  if (!state.img || !state.handlers) {
    return;
  }
  const { img, handlers } = state;
  img.removeEventListener("pointerdown", handlers.pointerdown);
  img.removeEventListener("pointermove", handlers.pointermove);
  img.removeEventListener("pointerup", handlers.pointerup);
  img.removeEventListener("pointercancel", handlers.pointerup);
  img.removeEventListener("dblclick", handlers.dblclick);
  img.removeEventListener("dragstart", handlers.dragstart);
  img.removeAttribute("data-asset-zoom");
  img.removeAttribute("data-asset-zoom-dragging");
  img.style.transform = "";
  clearFitStyles(img);
  state.img = null;
  state.handlers = null;
}

/**
 * 画像にズーム・パン用のポインタ操作を付ける。
 * @param {HTMLElement} dialog
 * @param {HTMLImageElement} img
 * @param {object} state
 */
function bindImage(dialog, img, state) {
  const handlers = {
    /** 左ボタンでドラッグ開始。 */
    pointerdown(event) {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      state.dragging = true;
      img.setPointerCapture(event.pointerId);
      img.setAttribute("data-asset-zoom-dragging", "");
    },
    /** ドラッグ中はポインタ移動量だけパンする。 */
    pointermove(event) {
      if (!state.dragging) {
        return;
      }
      state.panX += event.movementX;
      state.panY += event.movementY;
      applyTransform(state);
    },
    /** ドラッグ終了。 */
    pointerup() {
      state.dragging = false;
      img.removeAttribute("data-asset-zoom-dragging");
    },
    /** ダブルクリックで拡大率と位置をリセットする。 */
    dblclick(event) {
      event.preventDefault();
      resetTransform(state);
    },
    /** ブラウザ標準の画像ドラッグを抑止する。 */
    dragstart(event) {
      event.preventDefault();
    },
  };

  img.draggable = false;
  img.setAttribute("data-asset-zoom", "");
  img.addEventListener("pointerdown", handlers.pointerdown);
  img.addEventListener("pointermove", handlers.pointermove);
  img.addEventListener("pointerup", handlers.pointerup);
  img.addEventListener("pointercancel", handlers.pointerup);
  img.addEventListener("dblclick", handlers.dblclick);
  img.addEventListener("dragstart", handlers.dragstart);

  state.img = img;
  state.src = img.currentSrc || img.src;
  state.handlers = handlers;
  fitImageToPane(dialog, img);
  if (!img.complete) {
    img.addEventListener(
      "load",
      () => {
        if (state.img === img) {
          fitImageToPane(dialog, img);
        }
      },
      { once: true }
    );
  }
  resetTransform(state);
}

/**
 * ダイアログ内の現在の画像にバインドし直す。
 * 画像が差し替わった場合は拡大率をリセットする。
 * @param {HTMLElement} dialog
 */
function bindCurrentImage(dialog) {
  const img = dialog.querySelector("img");
  let state = states.get(dialog);
  if (!state) {
    state = {
      scale: 1,
      panX: 0,
      panY: 0,
      dragging: false,
      img: null,
      src: "",
      handlers: null,
    };
    states.set(dialog, state);
  }

  if (state.img === img) {
    const src = img ? img.currentSrc || img.src : "";
    if (img && state.src !== src) {
      state.src = src;
      fitImageToPane(dialog, img);
      resetTransform(state);
    }
    return;
  }

  unbindImage(state);
  if (img) {
    bindImage(dialog, img, state);
  }
}

/**
 * ライトボックスにホイール監視と画像差し替えの監視を付ける。
 * @param {HTMLElement} dialog
 */
function enhanceDialog(dialog) {
  if (dialog.dataset.assetZoomHost) {
    bindCurrentImage(dialog);
    return;
  }

  dialog.dataset.assetZoomHost = "1";
  dialog.addEventListener("wheel", (event) => onWheel(dialog, event), {
    passive: false,
  });

  const inner = new MutationObserver(() => bindCurrentImage(dialog));
  inner.observe(dialog, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  new ResizeObserver(() => {
    const state = states.get(dialog);
    if (state?.img) {
      fitImageToPane(dialog, state.img);
    }
  }).observe(dialog);
  bindCurrentImage(dialog);
}

app.registerExtension({
  name: "ComfyUI.AssetPreviewZoom",
  /** 既存のライトボックスと、あとから開くライトボックスを拡張する。 */
  setup() {
    injectStyle();
    findLightboxes(document.body).forEach(enhanceDialog);

    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          findLightboxes(node).forEach(enhanceDialog);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  },
});
