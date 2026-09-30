let override: number | null = null;

export const nowMs = () => override ?? Date.now();

export const setNowMs = (value: number | null) => {
  override = value;
};

export const getNowMs = () => override;
