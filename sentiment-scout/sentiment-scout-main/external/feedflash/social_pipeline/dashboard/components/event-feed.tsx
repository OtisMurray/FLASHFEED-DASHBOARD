"use client";

import { SourceBadge } from "./source-badge";
import type { Post } from "@/lib/types";
import { getSentimentColor, formatSentiment, getRelativeTime } from "@/lib/utils";

interface EventFeedProps {
  posts: Post[];
}

function sourceLabel(post: Post): string {
  if (post.source === "reddit" && post.subreddit) return `r/${post.subreddit}`;
  if (post.source === "twitter") return `@${post.author || "twitter"}`;
  if (post.source === "bluesky") return "Bluesky";
  return post.source;
}

export function EventFeed({ posts }: EventFeedProps) {
  if (posts.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-faint">
        No recent posts
      </div>
    );
  }

  return (
    <div className="px-2 pb-2 space-y-0.5">
      {posts.map((post) => (
        <div
          key={post.id}
          onClick={() => window.open(post.url, "_blank")}
          className="flex items-start gap-1.5 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer"
        >
          <SourceBadge source={post.source} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 mb-0.5">
              <span className="text-[10px] text-dim truncate">
                {sourceLabel(post)}
              </span>
              <span className="text-[10px] text-faint">
                {getRelativeTime(new Date(post.published_at))}
              </span>
              {post.is_rumor && (
                <span className="text-[8px] px-1 py-0 rounded bg-amber-500/20 text-amber-400 font-medium">
                  RUMOR
                </span>
              )}
            </div>
            <div className="text-[11px] text-secondary-foreground leading-tight line-clamp-2">
              {post.title || post.text.slice(0, 100)}
            </div>
          </div>
          <span
            className={`text-[10px] font-mono shrink-0 ${getSentimentColor(post.sentiment_score)}`}
          >
            {formatSentiment(post.sentiment_score)}
          </span>
        </div>
      ))}
    </div>
  );
}
