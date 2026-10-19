// Last-known wording from the user's 交易纪律.md for static/offline fallback.
// Live local text is parsed below; neither path calculates or executes a trade.
export const DISCIPLINE_ENTRIES = Object.freeze([
  {
    id: 'us-exposure',
    title: '基金持有量按美股含量确定。',
    detail: '如果美股含量低于40%，则【立刻】降低该基金持仓。',
  },
  {
    id: 'long-term',
    title: '一定要坚定长期持有。',
    detail: '这是收益最大化的途径，但同时也是回撤最大的，一定要坚持下来。',
  },
  {
    id: 'bond-reserve',
    title: '债基占总持仓的【1/6～1/3】，或债基持仓大于【5万元】。',
    detail: '既可以做压舱石，也可以择机加仓。',
  },
  {
    id: 'equity-scope',
    title: '基金的数量一定要精简，绝对不能开超市',
    detail: '。目前暂定：银华、国富、广发、华夏。',
  },
  {
    id: 'annual-profit',
    title: '止盈纪律',
    detail: '',
  },
  {
    id: 'annual-profit-100',
    title: '如果本年的年内涨幅收益率达到了100%，【一定】要大幅止盈（清除本金/卖出一半持仓，选金额大的）',
    detail: '',
  },
  {
    id: 'annual-profit-multiple',
    title: '如果本年的年内涨幅收益率超过了 平均年化收益率 的 3倍，【一定】要适当止盈（减仓20%）',
    detail: '',
  },
  {
    id: 'add-discipline',
    title: '加仓纪律， 加仓一定要是【少频次，高金额】的，单次加仓金额【1万元】。',
    detail: '美股含量不达标的基金，加仓金额/比例【减半】，卖出金额/比例【翻倍】。',
  },
  {
    id: 'add-discipline-decline',
    title: '自上次操作节点后，跌幅超过了 平均年化收益率 的2倍，进行一次加仓',
    detail: '',
  },
].map(entry => Object.freeze(entry)));

const IDS = {
  '1': 'us-exposure',
  '2': 'long-term',
  '3': 'bond-reserve',
  '4': 'equity-scope',
  '6': 'annual-profit',
  '6.1': 'annual-profit-100',
  '6.2': 'annual-profit-multiple',
  '7': 'add-discipline',
  '7.1': 'add-discipline-decline',
};
const clean = value => value.replaceAll('**', '').replace(/\s+/g, ' ').trim();
const invalid = () => { throw new Error('Invalid discipline document.'); };

function knownParagraph(text) {
  const plain = clean(text);
  if (plain.startsWith('基金持有量按美股含量确定')) return 'us-exposure';
  if (plain.startsWith('一定要坚定长期持有')) return 'long-term';
  if (plain.startsWith('一定要留有【1/3】比例的债基') || plain.startsWith('债基占总持仓的')) return 'bond-reserve';
  if (plain.startsWith('基金的数量一定要精简，绝对不能开超市')) return 'equity-scope';
  if (/^止盈纪律(?:$|[，。,:：\s])/.test(plain)) return 'annual-profit';
  if (/^加仓纪律(?:$|[，。,:：\s])/.test(plain)) return 'add-discipline';
  return null;
}

// Content-based identities keep unknown paragraphs stable when other rules are
// inserted or reordered. These are text identities, never inferred trade rules.
function textId(text) {
  let hash = 0xcbf29ce484222325n;
  for (const character of clean(text)) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `discipline-text-${hash.toString(16).padStart(16, '0')}`;
}

/** Parse display paragraphs and numbered subrules; never execute their text. */
export function parseDisciplineMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.length > 256 * 1024) invalid();
  const paragraphs = [];
  let current = null;
  const finish = () => {
    if (current) paragraphs.push(current);
    current = null;
  };
  for (const line of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) { finish(); continue; }
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      finish();
      if (clean(heading[1]) !== '交易纪律') paragraphs.push({ number: null, text: heading[1] });
      continue;
    }
    // Dotted subrules are independent entries, rather than continuations of
    // their parent. Accept both "6.1 text" and "6.1. text" markdown styles.
    const numbered = /^\s*(\d+\.\d+(?:\.\d+)*)(?:\.)?\s+(.*)$/.exec(line)
      || /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      finish();
      const levels = numbered[1].split('.').map(Number);
      if (levels.some(number => !Number.isSafeInteger(number) || number < 1)) invalid();
      const number = levels.join('.');
      current = { number, text: numbered[2] };
    } else if (/^\s*\d+(?:\.\d+)*\.?\s*$/.test(line)) {
      // Do not silently append a half-saved child marker to the prior rule.
      invalid();
    } else {
      // Known unnumbered headings also delimit a paragraph without a blank line.
      if (current && knownParagraph(line)) finish();
      if (current) current.text += ` ${line.trim()}`;
      else current = { number: null, text: line.trim() };
    }
  }
  finish();
  if (!paragraphs.length || paragraphs.length > 100) invalid();
  const seen = new Set(), ids = new Set(), genericOccurrences = new Map();
  const entries = paragraphs.map(({ number, text }) => {
    if ((number !== null && seen.has(number)) || (text.match(/\*\*/g)?.length || 0) % 2) invalid();
    if (number !== null) seen.add(number);
    const strong = /^\s*\*\*([\s\S]*?)\*\*/.exec(text);
    const title = clean(strong ? strong[1] : text);
    const detail = strong ? clean(text.slice(0, strong.index) + text.slice(strong.index + strong[0].length)) : '';
    if (!title || title.length > 10000 || detail.length > 10000 || /\u0000/.test(title + detail)) invalid();
    let id = number !== null ? IDS[number] || `discipline-${number.replaceAll('.', '-')}` : knownParagraph(text);
    if (!id) {
      const base = textId(text);
      const occurrence = (genericOccurrences.get(base) || 0) + 1;
      genericOccurrences.set(base, occurrence);
      id = occurrence === 1 ? base : `${base}-${occurrence}`;
    }
    if (id.length > 64 || ids.has(id)) invalid();
    ids.add(id);
    return Object.freeze({ id, title, detail });
  });
  return Object.freeze(entries);
}
