export const X_LIST_URL = 'https://x.com/i/lists/1636905485487202305';

export function buildExtractTweetCardsScript() {
  return `(() => {
    const statusPathPattern = /^\\/(?:[^/?#]+)\\/status\\/(\\d+)(?:[/?#].*)?$/;
    const isPromotedLabel = (text) => {
      const value = String(text || '').trim();
      return value === 'Promoted' || value === '广告' || value === 'Ad';
    };
    const normalizeStatusUrl = (href) => {
      try {
        const url = new URL(href, window.location.origin);
        if (!/^(x|twitter)\\.com$/.test(url.hostname) && !url.hostname.endsWith('.x.com') && !url.hostname.endsWith('.twitter.com')) {
          return null;
        }
        const match = url.pathname.match(/^\\/([^/?#]+)\\/status\\/(\\d+)(?:[/?#].*)?$/);
        if (!match) return null;
        return 'https://x.com/' + match[1] + '/status/' + match[2];
      } catch {
        return null;
      }
    };
    const readReplyCountText = (article) => {
      const reply = article.querySelector('[data-testid="reply"]');
      if (!reply) return null;
      const aria = String(reply.getAttribute('aria-label') || '').trim();
      if (aria) return aria;
      const ownText = String(reply.innerText || reply.textContent || '').trim();
      if (/^(reply|replies|回复|条回复)$/i.test(ownText) || /reply|replies|回复/i.test(ownText)) {
        return ownText;
      }
      return null;
    };
    const readTweetText = (article) => {
      const tweetTextNodes = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
      if (tweetTextNodes.length > 0) {
        return tweetTextNodes.map((node) => node.innerText || node.textContent || '').join('\\n').trim();
      }
      return '';
    };
    return Array.from(document.querySelectorAll('article')).map((article, index) => {
      const time = Array.from(article.querySelectorAll('time[datetime]'))
        .find((node) => !node.closest('[data-testid="card.wrapper"], [data-testid="quotedTweet"], [data-testid="quoteTweet"]'));
      const timeLink = time?.closest('a[href*="/status/"]');
      const statusUrl = normalizeStatusUrl(timeLink?.href) || null;
      const labels = Array.from(article.querySelectorAll('span, div')).map((node) => node.innerText || node.textContent || '');
      return {
        index,
        statusUrl,
        tweetText: readTweetText(article),
        publishedAt: time?.getAttribute('datetime') || null,
        replyCountText: readReplyCountText(article),
        isPromoted: labels.some(isPromotedLabel),
      };
    }).filter((card) => card.statusUrl || card.publishedAt || card.tweetText);
  })()`;
}
