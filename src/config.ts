export type AppConfig = {
  PORT: number;
  DATABASE_URL: string;
  FRONTEND_ORIGIN: string;
  ALLOW_SIM: boolean;
};

export const loadConfig = (): AppConfig => {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    PORT: Number(process.env.PORT || 8080),
    DATABASE_URL,
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || "*",
    ALLOW_SIM: process.env.ALLOW_SIM !== "false",
  };
};
