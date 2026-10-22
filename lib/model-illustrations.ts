// Hand-drawn product art lives in public/img/models/ as static assets.
// Adding an ID here (after adding its three files) is all it takes to link a model.
export const ILLUSTRATED_MODEL_IDS = ['model-1', 'model-2', 'model-5', 'model-7', 'model-8', 'model-9'] as const;

const illustrated: readonly string[] = ILLUSTRATED_MODEL_IDS;

export function modelIllustration(id: string): { src: string; srcSet: string; width: 540; height: 675 } | null {
  if (!illustrated.includes(id)) return null;
  const base = `/img/models/${id}`;
  return {
    src: `${base}-540x675.png`,
    srcSet: `${base}-252x315.png 252w, ${base}-540x675.png 540w`,
    width: 540,
    height: 675,
  };
}
