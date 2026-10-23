// Static, transparent square product line art; unlisted models keep their placeholder.
export const SQUARE_MODEL_IDS = ['model-1', 'model-2', 'model-3', 'model-4', 'model-5', 'model-6', 'model-7', 'model-8', 'model-9', 'model-10', 'model-11', 'model-12', 'model-13', 'model-14', 'model-15', 'model-16', 'model-17', 'model-18', 'model-19', 'model-20'] as const;
export const ILLUSTRATED_MODEL_IDS = SQUARE_MODEL_IDS;

export type ModelIllustration = {
  src: string;
  srcSet: string;
  width: number;
  height: number;
};

export function modelIllustration(id: string): ModelIllustration | null {
  if (!(ILLUSTRATED_MODEL_IDS as readonly string[]).includes(id)) return null;
  const base = `/img/models/${id}`;
  return {
    src: `${base}-540x540.png`,
    srcSet: `${base}-252x252.png 252w, ${base}-540x540.png 540w`,
    width: 540,
    height: 540,
  };
}
