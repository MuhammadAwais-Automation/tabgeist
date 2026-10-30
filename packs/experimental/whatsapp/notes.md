# WhatsApp pack

- Use the adapter, not the screen: `browser_read` with `data: true, op: "chats"` lists chats, `op: "messages", args: { chat: "<name or id>" }` reads one without opening it.
- Chat ids on current builds end in `@lid` and carry no phone number; ask for chats by name, and pass the id when a name fits several chats.
- Photos, videos and voice notes come back as their type and caption only.
- If the adapter says WhatsApp is still loading, wait a few seconds after the chat list shows and try again.
