import { Backend } from "../../../../interface/core/constants";
import { Reshape5 } from "../../../base/reshape5";
import { WebDNNCPUContext } from "../../../../interface/backend/cpu/cpuContext";
import { Tensor } from "../../../../interface/core/tensor";
import { OperatorEntry } from "../../../../interface/core/operator";

class CPUReshape5 extends Reshape5 {
  constructor() {
    super("cpu");
  }

  getTensorBackendRequirement(
    nInputs: number,
    nOutputs: number
  ): (Backend | null)[] {
    return ["cpu", "cpu"];
  }

  async run(context: WebDNNCPUContext, inputs: Tensor[]): Promise<Tensor[]> {
    context.assertsCPUTensorArray(inputs);
    const input = inputs[0];
    const shapeTensor = inputs[1];
    const computedShape = this.calcShape(input, shapeTensor);

    const output = context.emptyTensor(
      computedShape,
      input.dataType,
      input.data
    );
    return [output];
  }
}

export function getOpEntries(): OperatorEntry[] {
  return [
    {
      opType: "Reshape",
      backend: "cpu",
      opsetMin: 5,
      factory: () => new CPUReshape5(),
    },
  ];
}
