#!/usr/bin/env node

import { Command } from "commander";
import { run } from "../runner/runner.js";

type RootCommandOptions = {
  updateSnapshot: boolean | undefined;
};

export const action = async (options: RootCommandOptions) => {
  const { updateSnapshot } = options;
  await run({ updateSnapshot: updateSnapshot ?? false });
};
