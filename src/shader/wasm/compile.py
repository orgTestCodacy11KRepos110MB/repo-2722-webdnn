"""
compile operator kernels of c++ into wasm, then embed them in single ts file, to distribute single webdnn.js
"""

import base64
import glob
import os
import subprocess

CPP_SRC_DIR = "src"
DST_DIR = "../../descriptor_runner/operators/wasm/worker"
OPTIMIZATION = "-O3"

# change current directory to where this file is
os.chdir(os.path.dirname(os.path.abspath(__file__)))

srcs = glob.glob(CPP_SRC_DIR + "/**/*.cpp", recursive=True)

subprocess.check_call(["emcc", "-std=c++11", "--pre-js", "pre.js", "-o", f"{DST_DIR}/workerRaw.js", OPTIMIZATION, "-s", "ALLOW_MEMORY_GROWTH=1", *srcs], shell=os.name=='nt')

# embed wasm into worker js
with open(f"{DST_DIR}/workerRaw.wasm", "rb") as f:
    worker_wasm = f.read()
with open(f"{DST_DIR}/workerRaw.js", "rt") as f:
    worker_js = f.read()

worker_js_with_wasm = worker_js.replace("WASM_WORKER_WASM_BINARY_BASE64", base64.b64encode(worker_wasm).decode("ascii"))
worker_js_with_wasm_escaped = worker_js_with_wasm.replace("\\", "\\\\").replace("`", "\\`")

worker_data_url_src = f"""/* eslint-disable */
export const wasmWorkerSrcUrl = URL.createObjectURL(new File([`{worker_js_with_wasm_escaped}`], "worker.js", {{type: "text/javascript"}}));
"""

with open(f"{DST_DIR}/worker.ts", "wt") as f:
    f.write(worker_data_url_src)
