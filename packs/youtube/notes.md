# YouTube pack

- `browser_read` with `data: true` and `op: "video"` (the open video, or `args: { id }`), `op: "search", args: { query }`, or `op: "videos", args: { path: "/@channel/videos" }` gives clean data; the open tab does not move.
- Views and dates in lists are what YouTube shows ("1.2M views", "3 days ago"); `video` gives exact numbers.
- Reading is all this pack does. Liking, commenting and subscribing stay with the normal tools and wait for the user's click.
