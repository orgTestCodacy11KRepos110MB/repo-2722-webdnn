import { CPUTensor } from "../../../..";
import { WebDNNCPUContext } from "../../../../interface/backend/cpu/cpuContext";
import { OperatorEntry } from "../../../../interface/core/operator";
import { Tensor } from "../../../../interface/core/tensor";
import { arrayProd } from "../../../../util";
import { Conv } from "../../../base/conv";

// if number of elements of im2col output exceeds it, split the task by batch dimension.
const IM2COL_NUMEL_LIMIT = 511 * 1024 * 1024;

class CpuConv extends Conv {
  constructor() {
    super("cpu");
  }

  runSplitBatch(
    context: WebDNNCPUContext,
    inputXFull: CPUTensor,
    inputW: CPUTensor,
    inputB?: CPUTensor
  ): Tensor[] {
    if (this.group > 1) {
      throw new Error("Conv: batch splitting with group > 1 is not supported");
    }

    const {
      batch: allBatch,
      dilations,
      group,
      kernelShape,
      pads,
      strides,
      inShape,
      outShape,
      chIn,
      chInPerGroup,
      chOut,
      chOutPerGroup,
    } = this.calcShape(inputXFull.dims, inputW.dims);
    const im2colNumelPerBatch =
      group *
      outShape[0] *
      outShape[1] *
      chInPerGroup *
      kernelShape[0] *
      kernelShape[1];
    const iterBatch = Math.floor(IM2COL_NUMEL_LIMIT / im2colNumelPerBatch);
    const yShape = [allBatch, chOut, outShape[0], outShape[1]];
    if (iterBatch <= 0) {
      throw new Error(
        `Conv: the size of buffer needed to process single batch exceeds limit. Input shape: ${inputXFull.dims}, weight shape: ${inputW.dims}`
      );
    }
    const output = context.emptyTensor(yShape);
    for (let i = 0; i < allBatch; i += iterBatch) {
      const batch = Math.min(iterBatch, allBatch - i);
      const iterXShape = inputXFull.dims.slice();
      iterXShape[0] = batch;
      const xSizePerBatch = arrayProd(iterXShape.slice(1));
      const iterXData = new Float32Array(
        inputXFull.data.buffer,
        inputXFull.data.byteOffset +
          i * xSizePerBatch * Float32Array.BYTES_PER_ELEMENT,
        batch * xSizePerBatch
      );
      const inputX = context.emptyTensor(iterXShape, "float32", iterXData);
      const im2colData = new Float32Array(
          group *
            batch *
            outShape[0] *
            outShape[1] *
            chInPerGroup *
            kernelShape[0] *
            kernelShape[1]
        ),
        matmulData = new Float32Array(
          group * batch * outShape[0] * outShape[1] * chOutPerGroup
        ),
        transposeData = new Float32Array(
          output.data.buffer,
          output.data.byteOffset +
            i *
              chOut *
              outShape[0] *
              outShape[1] *
              Float32Array.BYTES_PER_ELEMENT,
          batch * chOut * outShape[0] * outShape[1]
        );
      this.im2col(
        inputX.data as Float32Array,
        im2colData,
        batch,
        dilations,
        group,
        kernelShape,
        pads,
        strides,
        inShape,
        outShape,
        chIn,
        chInPerGroup
      );
      this.matmul(
        im2colData,
        inputW.data as Float32Array,
        matmulData,
        group,
        batch * outShape[0] * outShape[1],
        chInPerGroup * kernelShape[0] * kernelShape[1],
        chOutPerGroup
      );
      this.transpose(
        matmulData,
        transposeData,
        group,
        batch,
        outShape[0] * outShape[1],
        chOutPerGroup
      );
    }

    if (inputB) {
      this.bias(
        inputB.data as Float32Array,
        output.data as Float32Array,
        allBatch,
        chOut,
        outShape[0] * outShape[1]
      );
    }
    return [output];
  }

  async run(context: WebDNNCPUContext, inputs: Tensor[]): Promise<Tensor[]> {
    context.assertsCPUTensorArray(inputs);
    const inputX = inputs[0],
      inputW = inputs[1],
      inputB = inputs[2];
    // TODO: 2D以外対応
    if (inputX.ndim !== 4) {
      throw new Error("Conv other than 2D is not yet supported");
    }
    const {
      batch,
      dilations,
      group,
      kernelShape,
      pads,
      strides,
      inShape,
      outShape,
      chIn,
      chInPerGroup,
      chOut,
      chOutPerGroup,
    } = this.calcShape(inputX.dims, inputW.dims);
    const im2colNumel =
      group *
      batch *
      outShape[0] *
      outShape[1] *
      chInPerGroup *
      kernelShape[0] *
      kernelShape[1];
    if (im2colNumel > IM2COL_NUMEL_LIMIT) {
      return this.runSplitBatch(context, inputX, inputW, inputB);
    }
    const im2colData = new Float32Array(im2colNumel),
      matmulData = new Float32Array(
        group * batch * outShape[0] * outShape[1] * chOutPerGroup
      ),
      transposeData = new Float32Array(
        batch * chOut * outShape[0] * outShape[1]
      );
    this.im2col(
      inputX.data as Float32Array,
      im2colData,
      batch,
      dilations,
      group,
      kernelShape,
      pads,
      strides,
      inShape,
      outShape,
      chIn,
      chInPerGroup
    );
    this.matmul(
      im2colData,
      inputW.data as Float32Array,
      matmulData,
      group,
      batch * outShape[0] * outShape[1],
      chInPerGroup * kernelShape[0] * kernelShape[1],
      chOutPerGroup
    );
    this.transpose(
      matmulData,
      transposeData,
      group,
      batch,
      outShape[0] * outShape[1],
      chOutPerGroup
    );
    if (inputB) {
      this.bias(
        inputB.data as Float32Array,
        transposeData,
        batch,
        chOut,
        outShape[0] * outShape[1]
      );
    }
    const output = context.emptyTensor(
      [batch, chOut, outShape[0], outShape[1]],
      "float32",
      transposeData
    );
    return [output];
  }

  private im2col(
    dX: Float32Array,
    dI: Float32Array,
    batch: number,
    dilations: number[],
    group: number,
    kernelShape: number[],
    pads: number[],
    strides: number[],
    inShape: number[],
    outShape: number[],
    chIn: number,
    chInPerGroup: number
  ): void {
    let idx = 0;
    for (let g = 0; g < group; g++) {
      for (let b = 0; b < batch; b++) {
        for (let oy = 0; oy < outShape[0]; oy++) {
          for (let ox = 0; ox < outShape[1]; ox++) {
            for (let ci = 0; ci < chInPerGroup; ci++) {
              for (let ky = 0; ky < kernelShape[0]; ky++) {
                for (let kx = 0; kx < kernelShape[1]; kx++) {
                  let v = 0;
                  const iny = oy * strides[0] - pads[0] + ky * dilations[0],
                    inx = ox * strides[1] - pads[1] + kx * dilations[1];
                  if (
                    iny >= 0 &&
                    iny < inShape[0] &&
                    inx >= 0 &&
                    inx < inShape[1]
                  ) {
                    v =
                      dX[
                        ((b * chIn + g * chInPerGroup + ci) * inShape[0] +
                          iny) *
                          inShape[1] +
                          inx
                      ];
                  }
                  dI[idx++] = v;
                }
              }
            }
          }
        }
      }
    }
  }

  private matmul(
    dI: Float32Array,
    dW: Float32Array,
    dT: Float32Array,
    group: number,
    bout: number,
    cinkhkw: number,
    chOutPerGroup: number
  ) {
    // DI(group, bout, cinkhkw) * dW(group, coutpergroup, cinkhkw) -> dT(group, bout, coutpergroup)
    for (let g = 0; g < group; g++) {
      for (let y = 0; y < bout; y++) {
        for (let x = 0; x < chOutPerGroup; x++) {
          let s = 0;
          for (let ip = 0; ip < cinkhkw; ip++) {
            s +=
              dI[(g * bout + y) * cinkhkw + ip] *
              dW[(g * chOutPerGroup + x) * cinkhkw + ip];
          }
          dT[(g * bout + y) * chOutPerGroup + x] = s;
        }
      }
    }
  }

  private transpose(
    dT: Float32Array,
    dO: Float32Array,
    group: number,
    batch: number,
    outarea: number,
    chOutPerGroup: number
  ) {
    // DT(group, batch, outh, outw, choutpergroup) -> dO(batch, group, choutpergroup, outh, outw)
    let idx = 0;
    for (let b = 0; b < batch; b++) {
      for (let g = 0; g < group; g++) {
        for (let c = 0; c < chOutPerGroup; c++) {
          for (let x = 0; x < outarea; x++) {
            dO[idx++] = dT[((g * batch + b) * outarea + x) * chOutPerGroup + c];
          }
        }
      }
    }
  }

  private bias(
    dB: Float32Array,
    dO: Float32Array,
    batch: number,
    chOut: number,
    outarea: number
  ) {
    let idx = 0;
    for (let b = 0; b < batch; b++) {
      for (let c = 0; c < chOut; c++) {
        for (let x = 0; x < outarea; x++) {
          dO[idx++] += dB[c];
        }
      }
    }
  }
}

export function getOpEntries(): OperatorEntry[] {
  return [
    {
      opType: "Conv",
      backend: "cpu",
      opsetMin: 1,
      factory: () => new CpuConv(),
    },
  ];
}
