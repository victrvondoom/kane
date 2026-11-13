// Requirement intelligence: deterministic decomposition of natural-language
// requirements into atomic acceptance criteria. No model decides pass/fail —
// this only structures text; verification is always a Kane CLI execution.
import crypto from 'node:crypto';

const BULLET = /^\s*(?:[-*•‣▪]|\d+[.)]|\[[ xX]?\]|[a-zA-Z][.)])\s+/;
const MODAL = /^(.*?\b(?:can|should|must|shall|is able to|are able to|will be able to|needs to|need to)\b)\s+(.+)$/i;

const PERSISTENCE = /\b(persist\w*|saved?|stored?|remain\w*|still|retain\w*|remember\w*|after (?:a |the )?(?:reload|refresh|re-?login|logging (?:back )?in|restart)|reload\w*|refresh\w*|log(?:s|ging)? (?:back )?in again|order history|database)\b/i;
const VISUAL = /\b(layout|colou?r|align\w*|responsive|styl\w*|font|icon|image|logo|theme|looks?|rendered?|overlap\w*|truncat\w*|contrast|viewport|mobile width|badge|banner|highlight\w*)\b/i;

export function categorize(text) {
  if (PERSISTENCE.test(text)) return 'persistence';
  if (VISUAL.test(text)) return 'visual';
  return 'functional';
}

function tidy(s) {
  s = s.replace(/\s+/g, ' ').trim().replace(/^[,;:\s]+|[,;\s]+$/g, '');
  if (!s) return '';
  s = s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(s) ? s : s + '.';
}

// "A user can register, log in and add items" -> one criterion per capability.
function splitCompound(sentence) {
  const m = sentence.replace(/[.!?]+$/, '').match(MODAL);
  if (!m) return [sentence];
  const [, head, tail] = m;
  if (!/,/.test(tail)) return [sentence];
  const parts = tail.split(/\s*,\s*(?:and\s+|or\s+)?|\s+and\s+(?=[a-z]+\s)/i).map((p) => p.trim()).filter(Boolean);
  // Only split when every part reads as its own action (verb phrase of 2+ words or a known verb).
  if (parts.length < 2 || parts.some((p) => p.split(' ').length < 2)) return [sentence];
  return parts.map((p) => `${head} ${p}`);
}

export function decompose(text) {
  const out = [];
  const seen = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(BULLET, '').trim();
    if (!line || /^#+\s/.test(line) || /^[A-Za-z ]{1,40}:$/.test(line)) continue;
    const sentences = line.split(/(?<=[.!?;])\s+(?=[A-Z0-9"'])/);
    for (const s of sentences) {
      const steps = s.split(/\s*;\s*/).flatMap(splitCompound);
      for (const step of steps) {
        const t = tidy(step);
        if (t.length < 8) continue;
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ text: t, category: categorize(t), mandatory: true });
      }
    }
  }
  return out;
}

export const textHash = (t) =>
  crypto.createHash('sha256').update(String(t).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 16);

export const formatKey = (n) => `AC-${String(n).padStart(3, '0')}`;
