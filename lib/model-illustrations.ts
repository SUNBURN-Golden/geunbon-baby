// Static artwork only; legacy portrait assets and transparent square line art coexist.
export const SQUARE_MODEL_IDS = ['model-11', 'model-12', 'model-13', 'model-14', 'model-15', 'model-16', 'model-17', 'model-18', 'model-19', 'model-20'] as const;
export const ILLUSTRATED_MODEL_IDS = ['model-1', 'model-2', 'model-5', 'model-7', 'model-8', 'model-9', ...SQUARE_MODEL_IDS] as const;

export type ModelIllustration = {
  src: string;
  srcSet: string;
  width: number;
  height: number;
  lineArt: boolean;
};

export function modelIllustration(id: string): ModelIllustration | null {
  if (!(ILLUSTRATED_MODEL_IDS as readonly string[]).includes(id)) return null;
  const lineArt = (SQUARE_MODEL_IDS as readonly string[]).includes(id);
  const height = lineArt ? 540 : 675;
  const smallHeight = lineArt ? 252 : 315;
  const base = `/img/models/${id}`;
  return {
    src: `${base}-540x${height}.png`,
    srcSet: `${base}-252x${smallHeight}.png 252w, ${base}-540x${height}.png 540w`,
    width: 540,
    height,
    lineArt,
  };
}
