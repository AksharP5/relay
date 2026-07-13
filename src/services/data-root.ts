export const relayDataRoot = () => {
  const override = Bun.env.RELAY_DATA_DIR?.trim();
  if (override) return override;

  const home = Bun.env.HOME;
  if (!home) return `${process.cwd()}/.relay`;
  return `${home}/.local/share/relay`;
};
