// Build-time patch to Cinny's web source: richer desktop notifications.
//   Stock:   title = room name, body = "New inbox notification from <user>"
//   Patched: title = sender (+ room for group chats), body = the message text (decrypted),
//            click → opens that room at that message instead of the Inbox.
// Each edit is anchored; if an anchor moves upstream the patch warns and skips that edit,
// leaving stock behaviour (build never fails because of this).
const fs = require('fs');
const path = require('path');

const cinnyDir = process.argv[2] || path.join(__dirname, '..', '..', 'cinny-web');
const file = path.join(cinnyDir, 'src/app/pages/client/ClientNonUIFeatures.tsx');
const MARK = '/* cinny-electron:rich-notify */';

let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) {
  console.log('notify patch: already applied');
  process.exit(0);
}

const edits = [
  {
    name: 'imports',
    find: `import { useMediaAuthentication } from '../../hooks/useMediaAuthentication';`,
    replace: `import { useMediaAuthentication } from '../../hooks/useMediaAuthentication';
import { useRoomNavigate } from '../../hooks/useRoomNavigate';
import { trimReplyFromBody } from '../../utils/room';
${MARK}
const NOTIFY_PREVIEW_MAX = 180;
const describeNotifyEvent = (mEvent: any): string => {
  const c = mEvent.getContent?.() ?? {};
  const type = mEvent.getType?.();
  if (type === 'm.room.encrypted') return 'Encrypted message';
  if (type === 'm.sticker') return 'Sent a sticker';
  if (type === 'm.call.invite') return 'Incoming call';
  if (type === 'm.reaction') return \`Reacted \${c['m.relates_to']?.key ?? ''}\`.trim();
  const fresh = c['m.new_content'] ?? c;
  switch (fresh.msgtype) {
    case 'm.image': return '📷 Image';
    case 'm.video': return '🎬 Video';
    case 'm.audio': return '🎤 Audio';
    case 'm.file': return \`📎 \${fresh.body ?? 'File'}\`;
    case 'm.location': return '📍 Location';
    default: break;
  }
  let body: string = typeof fresh.body === 'string' ? fresh.body : '';
  body = trimReplyFromBody(body).replace(/\\s+/g, ' ').trim();
  if (fresh.msgtype === 'm.emote') body = \`* \${body}\`;
  if (!body) return 'New message';
  return body.length > NOTIFY_PREVIEW_MAX ? \`\${body.slice(0, NOTIFY_PREVIEW_MAX - 1)}…\` : body;
};`,
  },
  {
    name: 'notify signature + body',
    find: `  const notify = useCallback(
    ({
      roomName,
      roomAvatar,
      username,
    }: {
      roomName: string;
      roomAvatar?: string;
      username: string;
      roomId: string;
      eventId: string;
    }) => {
      const noti = new window.Notification(roomName, {
        icon: roomAvatar,
        badge: roomAvatar,
        body: \`New inbox notification from \${username}\`,
        silent: true,
      });

      noti.onclick = () => {
        if (!window.closed) navigate(getInboxNotificationsPath());
        noti.close();
        notifRef.current = undefined;
      };

      notifRef.current?.close();
      notifRef.current = noti;
    },
    [navigate]
  );`,
    replace: `  const { navigateRoom } = useRoomNavigate();
  const notify = useCallback(
    ({
      roomName,
      roomAvatar,
      username,
      roomId,
      eventId,
      preview,
      isDirect,
    }: {
      roomName: string;
      roomAvatar?: string;
      username: string;
      roomId: string;
      eventId: string;
      preview?: string;
      isDirect?: boolean;
    }) => {
      const title = isDirect || username === roomName ? username : \`\${username} · \${roomName}\`;
      const noti = new window.Notification(title, {
        icon: roomAvatar,
        badge: roomAvatar,
        body: preview || \`New message from \${username}\`,
        tag: roomId,
        silent: true,
      });

      noti.onclick = () => {
        if (!window.closed) {
          try {
            window.focus();
            navigateRoom(roomId, eventId);
          } catch {
            navigate(getInboxNotificationsPath());
          }
        }
        noti.close();
        notifRef.current = undefined;
      };

      notifRef.current?.close();
      notifRef.current = noti;
    },
    [navigate, navigateRoom]
  );`,
  },
  {
    name: 'pass preview at call site',
    find: `          username: getMemberDisplayName(room, sender) ?? getMxIdLocalPart(sender) ?? sender,
          roomId: room.roomId,
          eventId,
        });`,
    replace: `          username: getMemberDisplayName(room, sender) ?? getMxIdLocalPart(sender) ?? sender,
          roomId: room.roomId,
          eventId,
          preview: describeNotifyEvent(mEvent),
          isDirect: room.getJoinedMemberCount() <= 2,
        });`,
  },
  {
    // Encrypted events arrive before decryption finishes; wait for it so the preview is real text.
    name: 'await decryption',
    find: `      if (showNotifications && notificationPermission('granted')) {
        const avatarMxc =`,
    replace: `      if (showNotifications && notificationPermission('granted')) {
        if (mEvent.isEncrypted() && mEvent.isBeingDecrypted()) {
          mEvent.once('Event.decrypted' as any, () => handleTimelineEvent(mEvent, room, toStartOfTimeline, removed, data));
          unreadCacheRef.current.delete(room.roomId);
          return;
        }
        const avatarMxc =`,
  },
];

let applied = 0;
for (const e of edits) {
  if (!src.includes(e.find)) {
    console.warn(`notify patch: ANCHOR NOT FOUND for "${e.name}" — skipping`);
    continue;
  }
  src = src.replace(e.find, e.replace);
  applied += 1;
}

if (applied < edits.length) {
  // Partial application could leave inconsistent code; only write if everything applied.
  console.warn(`notify patch: ${applied}/${edits.length} anchors matched — leaving stock notifications`);
  process.exit(0);
}

fs.writeFileSync(file, src);
console.log('notify patch: applied');
