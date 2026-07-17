import { task } from "@trigger.dev/sdk";

export const hello = task({
  id: "hello",
  run: async (payload: { name: string }) => {
    return { greeting: `hello ${payload.name}` };
  },
});
