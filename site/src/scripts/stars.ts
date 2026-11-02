// 首屏 GitHub 按钮的星数：页面里是构建时的数字，打开时再取一次站内的 /stars.json（线上每 2 分钟刷新，见 deploy/builder.mjs）。
// 只请求自己的站，不请求 GitHub，访客的 IP 不会发给第三方。取不到就留着构建时的数字。
import { fmtStars, parseStars } from "../lib/stars";

const link = document.querySelector<HTMLElement>("[data-stars-label]");
const count = link?.querySelector<HTMLElement>("[data-stars]");

if (link && count) {
  fetch("/stars.json")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const stars = parseStars(data);
      if (stars === null) return;
      count.textContent = fmtStars(stars);
      link.setAttribute("aria-label", link.dataset.starsLabel!.replace("{stars}", String(stars)));
    })
    .catch(() => { /* 留着构建时的数字 */ });
}
