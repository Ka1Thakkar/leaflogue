export function initSalonWall(root: HTMLElement): () => void {
  const wall = root.querySelector<HTMLElement>("#wall");
  const input = root.querySelector<HTMLInputElement>("#q");
  const count = root.querySelector<HTMLElement>("#count");
  if (!wall || !input || !count) return () => {};
  const controller = new AbortController();
  const chips = [...root.querySelectorAll<HTMLButtonElement>(".chips button")];
  const pieces = [...wall.querySelectorAll<HTMLElement>(".piece")];
  const originals = pieces.map(piece => ({ piece, quote: piece.querySelector("blockquote"), text: piece.querySelector("blockquote")?.textContent ?? "" }));
  function run(raw: string) {
    const term = raw.trim().toLocaleLowerCase(); let hits = 0;
    for (const { piece, quote, text } of originals) {
      const words = `${text} ${piece.dataset.words ?? ""} ${piece.querySelector(".cartel")?.textContent ?? ""}`;
      const hit = term.length > 1 && words.toLocaleLowerCase().includes(term);
      piece.classList.toggle("hit", hit); if (hit) hits++;
      if (quote) {
        quote.replaceChildren(document.createTextNode(text));
        if (hit && text.toLocaleLowerCase().includes(term)) {
          quote.replaceChildren(); let offset = 0; let index = text.toLocaleLowerCase().indexOf(term);
          while (index >= 0) {
            quote.append(document.createTextNode(text.slice(offset, index)));
            const mark = document.createElement("mark"); mark.textContent = text.slice(index, index + term.length); quote.append(mark);
            offset = index + term.length; index = text.toLocaleLowerCase().indexOf(term, offset);
          }
          quote.append(document.createTextNode(text.slice(offset)));
        }
      }
    }
    wall!.classList.toggle("searching", term.length > 1);
    count!.textContent = term.length > 1 ? `${hits} of ${pieces.length}` : "";
    chips.forEach(chip => chip.setAttribute("aria-pressed", String(chip.textContent === term)));
  }
  input.addEventListener("input", () => run(input.value), { signal: controller.signal });
  chips.forEach(chip => chip.addEventListener("click", () => { input.value = chip.getAttribute("aria-pressed") === "true" ? "" : chip.textContent ?? ""; run(input.value); }, { signal: controller.signal }));
  return () => controller.abort();
}
