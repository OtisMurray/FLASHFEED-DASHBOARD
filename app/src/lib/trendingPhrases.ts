type SocialLike = Record<string, any>;

const STOP_WORDS = new Set([
  "the","and","for","with","this","that","from","they","you","your","are","was","were","have","has",
  "will","would","could","should","about","into","over","under","after","before","just","like","than",
  "then","them","there","their","what","when","where","stock","stocks","share","shares","market",
  "price","today","tomorrow","really","still","going","think","watch","watching","trade","trading"
]);

function postText(post: SocialLike): string {
  return [
    post?.text,
    post?.body,
    post?.title,
    post?.message,
    post?.content,
    post?.description,
  ].filter(Boolean).join(" ");
}

export function buildTrendingPhrases(posts: SocialLike[] = [], limit = 12): Array<{ phrase: string; count: number }> {
  const counts = new Map<string, number>();

  for (const post of posts) {
    const text = postText(post);
    if (!text) continue;

    const cashtags = text.match(/\$[A-Z]{1,6}\b/g) || [];
    for (const tag of cashtags) {
      const key = tag.toUpperCase();
      counts.set(key, (counts.get(key) || 0) + 2);
    }

    const words = text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9$\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (phrase.length >= 9) counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }

    for (const word of words) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
    .slice(0, limit);
}
