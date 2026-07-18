import {
  task
} from "../../../../../../chunk-KN3TVMIA.mjs";
import "../../../../../../chunk-7QFS6F4R.mjs";
import {
  __name,
  init_esm
} from "../../../../../../chunk-GXTODWZ5.mjs";

// trigger/hello.ts
init_esm();
var hello = task({
  id: "hello",
  run: /* @__PURE__ */ __name(async (payload) => {
    return { greeting: `hello ${payload.name}` };
  }, "run")
});
export {
  hello
};
//# sourceMappingURL=hello.mjs.map
