// ページ本文領域・代表行の実測高さ (px) を取る Svelte action (T5c: 画面高さ駆動のページ行容量、
// summary-instrument-paging spec §2-c)。ResizeObserver で要素の content-rect 高さを継続監視し、
// 変化のたびに onMeasure(px) を呼ぶ。既存の TickerLane の「実測 px + JS 算出」流儀
// (scrollHeight/clientHeight 実測) の親戚だが、あちらは effect 内で
// 手動 measure するのに対しこちらは resize を継続監視する必要がある (ページ本文領域はビューポート
// リサイズで変わりうる) ため ResizeObserver を使う。jsdom は ResizeObserver 未実装のため、
// テスト環境では no-op になり実測値は 0 のまま (呼び出し側の rowCapacity/cityBudgetFromArea の
// fallback パスに落ちる。既存テストの回帰確認はこの fallback 経路が担う)。
// onMeasure が undefined のときは何もしない (1 要素だけを測る「代表行」用途で、
// #each の i===0 判定と組み合わせて `use:measureHeight={i === 0 ? onRow : undefined}` の形で使う)
//
// content-box (padding/border を含まない) を報告する。「コンテナの中で子要素に使える高さ」
// (例: TsunamiPanel の .tiles、QuakePanel/LatestQuakeCard の .page-body) はこちらが正しい単位
// — コンテナ自身の padding は子に使えないため
export function measureHeight(node: HTMLElement, onMeasure?: (heightPx: number) => void) {
  return createHeightAction(node, onMeasure, (entry) => entry.contentRect.height);
}

// border-box (padding/border を含む) を報告する variant (T6b、Codex レビュー M3 派生 M-b 対応)。
// 「要素自身が親のレイアウトの中で占有する縦幅」(例: TsunamiPanel の予報区/観測 tile が .tiles の
// flex column の中で消費する高さ、.coast-row/.observation-row がリストの中で1行として消費する
// 高さ) はこちらが正しい単位 — measureHeight (content-box) を使うと padding 分だけ「相手が
// 実際に消費している高さ」を過小評価し、可用高さ (sectionAvailableHeight) の過大評価につながる。
// ResizeObserver.borderBoxSize (主要ブラウザ対応、Safari 含む) を優先し、未対応環境では
// getBoundingClientRect().height (定義上そのものが border-box 高さ) にフォールバックする
export function measureBorderHeight(node: HTMLElement, onMeasure?: (heightPx: number) => void) {
  return createHeightAction(node, onMeasure, borderBoxHeightOf);
}

/** 要素の border-box 高さ・上端・下端をまとめた形 (T6b、M-a 対応)。TsunamiPanel の予報区 tile /
 *  観測 tile のように、レイアウトが縦積み (stacked) か横並び (grid 2 カラム) かを CSS container
 *  query の状態から JS で直接読めない場合に、実測の getBoundingClientRect() から幾何的に判定する
 *  ための top/bottom も一緒に持つ (isStackedLayout、instrument-layout.ts と組み合わせて使う)。
 *  top/bottom はスクロール位置に依存するが、同じスクロールコンテナ内の 2 要素同士の
 *  相対比較 (bottom vs top) にしか使わないためスクロール量には影響されない */
export interface MeasuredBox {
  height: number;
  top: number;
  bottom: number;
}

/** 要素の現在の border-box 高さ・top/bottom を getBoundingClientRect() から直接読む。
 *  getBoundingClientRect().height は定義上そのものが border-box 高さなので、
 *  ResizeObserverEntry 経由の borderBoxHeightOf のようなフォールバック分岐は不要 */
export function readBox(node: Element): MeasuredBox {
  const rect = node.getBoundingClientRect();
  return { height: rect.height, top: rect.top, bottom: rect.bottom };
}

// 「片方の tile が動いたら両方読み直す」ための、ペイロードを持たない汎用の resize 通知 action
// (T6c、M-a rect 鮮度対応)。旧 measureBox はコールバック内で自分の rect だけを onMeasure に渡す
// 構造だったため、サイズは変わらず位置だけ動いた相手 tile の rect が古いまま取り残される
// (静的→ページング昇格で片方の高さが変わっても、もう片方は自分のサイズが変わらなければ
// ResizeObserver が発火しない) 問題があった。observeResize は「誰かが動いた」というシグナル
// だけを渡し、呼び出し側 (TsunamiPanel.svelte の remeasureTiles) が両方の要素の rect を
// まとめて読み直す設計に置き換えた
export function observeResize(node: HTMLElement, onResize?: () => void) {
  let current = onResize;
  if (current == null || typeof ResizeObserver === "undefined") {
    return {
      update(next?: () => void) {
        current = next;
      },
    };
  }
  const observer = new ResizeObserver(() => {
    current?.();
  });
  observer.observe(node);
  return {
    update(next?: () => void) {
      current = next;
    },
    destroy() {
      observer.disconnect();
    },
  };
}

function createHeightAction(
  node: HTMLElement,
  onMeasure: ((heightPx: number) => void) | undefined,
  extract: (entry: ResizeObserverEntry) => number,
) {
  let current = onMeasure;
  if (current == null || typeof ResizeObserver === "undefined") {
    return {
      update(next?: (heightPx: number) => void) {
        current = next;
      },
    };
  }
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      current?.(extract(entry));
    }
  });
  observer.observe(node);
  return {
    update(next?: (heightPx: number) => void) {
      current = next;
    },
    destroy() {
      observer.disconnect();
    },
  };
}

/** ResizeObserverEntry から border-box 高さを取り出す純関数部分 (フォールバック分岐を
 *  jsdom 抜きで単体テストできるよう切り出す)。borderBoxSize は仕様上 ResizeObserverSize[]
 *  (配列) だが、一部実装が単一オブジェクトを返した過去があったため両対応で読む */
export function borderBoxHeightOf(entry: ResizeObserverEntry): number {
  const boxSize = entry.borderBoxSize as ResizeObserverSize[] | ResizeObserverSize | undefined;
  if (boxSize != null) {
    const size = Array.isArray(boxSize) ? boxSize[0] : boxSize;
    if (size != null && typeof size.blockSize === "number") return size.blockSize;
  }
  return entry.target.getBoundingClientRect().height;
}
