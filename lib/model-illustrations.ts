// Static, transparent square product line art; unlisted models keep their placeholder.
export const SQUARE_MODEL_IDS = ['model-1', 'model-2', 'model-3', 'model-4', 'model-5', 'model-6', 'model-7', 'model-8', 'model-9', 'model-10', 'model-11', 'model-12', 'model-13', 'model-14', 'model-15', 'model-16', 'model-17', 'model-18', 'model-19', 'model-20', 'model-21', 'model-22', 'model-23', 'model-24', 'model-25', 'model-26', 'model-27', 'model-28', 'model-29', 'model-30', 'model-31', 'model-32', 'model-33', 'model-34', 'model-35', 'model-36', 'model-37', 'model-38', 'model-39', 'model-40', 'model-41'] as const;
export const ILLUSTRATED_MODEL_IDS = SQUARE_MODEL_IDS;

export type ModelIllustration = {
  src: string;
  width: number;
  height: number;
};

export function modelIllustration(id: string): ModelIllustration | null {
  if (!(ILLUSTRATED_MODEL_IDS as readonly string[]).includes(id)) return null;
  return {
    src: `/img/models/${id}.svg`,
    width: 1080,
    height: 1080,
  };
}
