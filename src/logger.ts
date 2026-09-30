const encode = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
};

const write = (level: string, message: string, extra?: unknown) => {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(extra === undefined ? {} : { extra: encode(extra) }),
  };
  const output = level === "error" ? console.error : console.log;
  output(JSON.stringify(entry));
};

export const logger = {
  info: (message: string, extra?: unknown) => write("info", message, extra),
  warn: (message: string, extra?: unknown) => write("warn", message, extra),
  error: (message: string, extra?: unknown) => write("error", message, extra),
};
