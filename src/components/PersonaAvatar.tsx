import { useEffect, useState } from 'react';
import { resolveAvatar, loadStyle, avatarDataUriSync, type AvatarConfig } from '../lib/personaAvatar';

/**
 * Het gezicht van een persona. Zonder opgeslagen avatar: een robotje dat uit
 * de naam volgt. Rond, met de gekozen achtergrond; `alt` is leeg omdat de naam
 * er altijd naast staat.
 */
export function PersonaAvatar({ avatar, name, size = 32, className = '', title }: {
  avatar?: AvatarConfig | null | unknown;
  name: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const cfg = resolveAvatar(avatar, name);
  const [, setTick] = useState(0);
  const uri = avatarDataUriSync(cfg);

  useEffect(() => {
    if (uri) return;
    let alive = true;
    loadStyle(cfg.style).then(() => { if (alive) setTick(n => n + 1); }).catch(() => {});
    return () => { alive = false; };
  }, [uri, cfg.style]);

  return (
    <span
      className={`inline-block flex-shrink-0 rounded-full overflow-hidden bg-gray-100 align-middle ${className}`}
      style={{ width: size, height: size }}
      title={title}
      data-testid="persona-avatar"
    >
      {uri && <img src={uri} alt="" width={size} height={size} className="w-full h-full" draggable={false} />}
    </span>
  );
}
