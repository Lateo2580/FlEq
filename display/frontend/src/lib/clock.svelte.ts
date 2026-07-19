export function createClock(): { readonly now: Date; stop(): void } {
  let now = $state(new Date());
  const id = setInterval(() => {
    now = new Date();
  }, 1000);

  return {
    get now() {
      return now;
    },
    stop(): void {
      clearInterval(id);
    },
  };
}
