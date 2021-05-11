import os
import glob
from webdnn.optimization_pass import OptimizationPassResult

class OptimizationPassResultCPU(OptimizationPassResult):
    def write_code(self, root_directory: str):
        directory = os.path.join(root_directory, "src/descriptor_runner/operators/cpu/operators/autogen")
        for path in glob.glob(os.path.join(directory, "*.ts")):
            os.remove(path)
        for key, s in self.operator_shaders.items():
            with open(os.path.join(directory, f"{key}.ts"), "w") as f:
                f.write(s.ts_code)
