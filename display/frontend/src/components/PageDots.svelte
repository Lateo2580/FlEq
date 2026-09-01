<script lang="ts">
  // 詳細ページャの現在地表示 + ジャンプ操作 (spec §3 改訂【確定】、T8①)。旧「N/M」数字
  // (QuakePanel/LatestQuakeCard はグループ内番号、TsunamiPanel は種別/観測内の連番) を廃止し、
  // 4 箇所のページャ (QuakePanel・LatestQuakeCard の詳細ページ、TsunamiPanel の予報区・観測
  // ページ) で共有するドット列に統合した。ドットは常に「全ページ」を 1:1 で表す
  // (cycler.index/total、グループ内番号ではない)。button 要素なのでクリックで該当ページへ
  // ジャンプできる (page-cycler.svelte.ts の jumpTo。kiosk 環境でも無害、Raspi500 の
  // マウス運用がレビュー決定・spec §8 錨改訂済み)。
  //
  // 現在ページの強調は opacity ではなく大きさ + color-mix の濃さで表現する (§8「opacity による
  // 減光は使わない」規範)。種別/震度グループの境界に gap を入れる任意機能は T8① で一度実装したが、
  // preview 目視レビューで「間隔が不揃いに見える」と不評だったため撤去した (T8⑤)。全ドット常に
  // 均等間隔にする
  let {
    total,
    current,
    onJump,
    windowed = false,
  }: {
    total: number;
    current: number;
    onJump: (index: number) => void;
    /** 緊急気象パネル用。全ページ数を保持したまま最大 7 token だけを描く。 */
    windowed?: boolean;
  } = $props();

  type PageToken =
    | { type: "page"; index: number }
    | { type: "ellipsis"; key: "leading" | "trailing" };

  const tokens = $derived.by((): PageToken[] => {
    if (!windowed || total <= 7) {
      return Array.from({ length: Math.max(0, total) }, (_, index) => ({ type: "page", index }));
    }
    const safeCurrent = Math.max(0, Math.min(total - 1, current));
    if (safeCurrent <= 3) {
      return [
        ...Array.from({ length: 5 }, (_, index) => ({ type: "page", index }) as const),
        { type: "ellipsis", key: "trailing" },
        { type: "page", index: total - 1 },
      ];
    }
    if (safeCurrent >= total - 4) {
      return [
        { type: "page", index: 0 },
        { type: "ellipsis", key: "leading" },
        ...Array.from(
          { length: 5 },
          (_, offset) => ({ type: "page", index: total - 5 + offset }) as const,
        ),
      ];
    }
    return [
      { type: "page", index: 0 },
      { type: "ellipsis", key: "leading" },
      { type: "page", index: safeCurrent - 1 },
      { type: "page", index: safeCurrent },
      { type: "page", index: safeCurrent + 1 },
      { type: "ellipsis", key: "trailing" },
      { type: "page", index: total - 1 },
    ];
  });
</script>

{#if total > 1}
  <div class="page-dots" class:windowed role="group" aria-label="ページ切替 (全{total}ページ)">
    {#each tokens as token (`${token.type}:${token.type === "page" ? token.index : token.key}`)}
      {#if token.type === "page"}
        <button
          type="button"
          class="page-dot"
          class:current={token.index === current}
          aria-label="{token.index + 1}/{total}ページ"
          aria-current={token.index === current ? "true" : undefined}
          onclick={() => onJump(token.index)}
        ></button>
      {:else}
        <span class="page-ellipsis" aria-hidden="true">…</span>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .page-dots {
    display: flex;
    align-items: center;
    align-self: center;
    /* .page-dot::before の 24px hit target を chrome の box 内へ収める。
       8px の見える dot だけで行高を決めると、absolute な hit target が親の
       scrollHeight にだけ加算され、probe/live geometry の containment を壊す。 */
    min-height: 24px;
    flex-wrap: wrap;
    gap: 4px; /* Task13 以前の間隔に復帰 (下記 .page-dot 撤回理由と同じ経緯) */
    margin-left: auto;
  }
  .page-dots.windowed {
    box-sizing: border-box;
    inline-size: 80px;
    max-inline-size: 80px;
    block-size: 24px;
    min-height: 24px;
    flex-wrap: nowrap;
    justify-content: flex-end;
  }
  .page-ellipsis {
    flex: 0 0 8px;
    inline-size: 8px;
    block-size: 24px;
    line-height: 24px;
    text-align: center;
    color: var(--role-muted);
  }
  /* 透明 24×24px 箱 + ::before 描画の構造 (Task13) は、26 ページ相当の多ページ時に
     624px → 2 行折返しを起こしメイン表示を圧迫する実害があった (preview 目視レビュー 2026-07-18)。
     ドット自身を旧来どおり見えるサイズで直描きする構造に撤回し、ヒット領域の拡張だけ
     ::before に残す (下記)。縦 24px + 横は間隔上限 (約10px) までの既知の限界として
     docs/specs/display-design-system.md §6 に記載する */
  .page-dot {
    position: relative; /* ::before ヒット領域拡張の基準 */
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
  }
  /* button の外形は current に関係なく 8px。見える円だけを内側で 6px/8px に変え、
     active index の移動が flex wrap と chrome 高を変えないようにする。 */
  .page-dot::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    /* 現在ページは大きさ + 濃さで強調する。非強調側は透明との color-mix で薄める
       (opacity プロパティは使わない、§8 規範)。透明との混色なので背景色 (種別色面等) が
       透けて自然に馴染む */
    background: color-mix(in srgb, var(--fg) 35%, transparent);
    transition:
      background-color var(--spring-effects-default-dur) var(--spring-effects-default),
      width var(--spring-effects-default-dur) var(--spring-effects-default),
      height var(--spring-effects-default-dur) var(--spring-effects-default);
  }
  .page-dot.current::after {
    width: 8px;
    height: 8px;
    background: var(--fg);
  }
  /* タップ/クリックのヒット領域だけを拡張する透明な当たり判定。見た目のドットサイズ
     (6px/8px) は変えない。縦 24px は隣接ドットと重ならない (ドット行の上下は非対話の余白)。
     横は 10px 固定 (pitch = ドット幅+gap の上限) で、current 時 (8px+4px=12px pitch) は
     隣接ヒット領域がわずかに重なりうるが、優先度は「多ページ折返し圧迫の回避」側にある */
  .page-dot::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 10px;
    height: 24px;
    transform: translate(-50%, -50%);
  }
  @media (hover: hover) {
    .page-dot:hover::after {
      background: color-mix(in srgb, var(--fg) 60%, transparent);
    }
    .page-dot.current:hover::after {
      background: var(--fg);
    }
  }
  .page-dot:focus-visible {
    outline: 2px solid var(--role-muted);
    outline-offset: 2px; /* ドット同士が隣接しなくなったため外側 offset で描ける */
  }
  @media (prefers-reduced-motion: reduce) {
    .page-dot::after {
      transition: none;
    }
  }
</style>
