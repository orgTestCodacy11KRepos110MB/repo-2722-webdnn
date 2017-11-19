from typing import List

from webdnn.backend.webgl.attributes.channel_mode import ChannelMode, ChannelModeEnum
from webdnn.backend.webgl.generator import WebGLDescriptorGenerator
from webdnn.backend.webgl.kernel import Kernel
from webdnn.backend.webgl.kernel_code import KernelCode
from webdnn.backend.webgl.kernels.util import texel_fetch, get_output_position, change_order
from webdnn.graph.axis import Axis
from webdnn.graph.operators.im2col import Im2Col
from webdnn.graph.order import OrderNHWC


@WebGLDescriptorGenerator.register_handler(Im2Col)
def im2col(op: Im2Col) -> List[Kernel]:
    im = op.inputs["im"]
    col = op.outputs["col"]
    H1 = im.shape_dict[Axis.H]
    W1 = im.shape_dict[Axis.W]
    C1 = im.shape_dict[Axis.C]

    assert im.order.check_same_axes(OrderNHWC)
    assert col.order.check_same_axes(OrderNHWC)
    assert ChannelMode.get(im) == ChannelModeEnum.R

    if ChannelMode.get(col) == ChannelModeEnum.R:
        code = KernelCode(["""
void main() {
    ivec4 variable_position_col = """, change_order(get_output_position(col), col.order, OrderNHWC), f""";

    int n  = variable_position_col.x;
    int h2 = variable_position_col.y;
    int w2 = variable_position_col.z;
    int khkwc1 = variable_position_col.w;

    int kh = khkwc1 / {C1} / {op.KW};
    int kw = khkwc1 / {C1} - kh * {op.KW};
    int c1 = khkwc1 - (kh * {op.KW} + kw) * {C1};

    int h1 = h2 * {op.SH} - {op.PH} + kh * {op.DH};
    int w1 = w2 * {op.SW} - {op.PW} + kw * {op.DW};

    if (h1 < 0 || h1 >= {H1} || w1 < 0 || w1 >= {W1}) {{
        gl_FragColor.r = 0.0;
    }} else {{
        gl_FragColor.r = """, texel_fetch(im, change_order("vec4(n, h1, w1, c1)", OrderNHWC, im.order)), f""".r;
    }}
}}
"""])

    elif ChannelMode.get(col) == ChannelModeEnum.RGBA:
        code = KernelCode(["""
void main() {
    ivec4 variable_position_col = """, change_order(get_output_position(col), col.order, OrderNHWC), f""";

    int n  = variable_position_col.x;
    int h2 = variable_position_col.y;
    int w2 = variable_position_col.z;
    int khkwc1 = variable_position_col.w;

    int kh = khkwc1 / {C1} / {op.KW};
    int kw = khkwc1 / {C1} - kh * {op.KW};
    int c1 = khkwc1 - (kh * {op.KW} + kw) * {C1};

    int h1 = h2 * {op.SH} - {op.PH} + kh * {op.DH};
    int w1 = w2 * {op.SW} - {op.PW} + kw * {op.DW};

    if (h1 < 0 || h1 >= {H1} || w1 < 0 || w1 >= {W1}) {{
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    }} else {{
        gl_FragColor.r = """, texel_fetch(im, change_order("vec4(n, h1, w1, c1 + 0)", OrderNHWC, im.order)), f""".r;
        gl_FragColor.g = """, texel_fetch(im, change_order("vec4(n, h1, w1, c1 + 1)", OrderNHWC, im.order)), f""".r;
        gl_FragColor.b = """, texel_fetch(im, change_order("vec4(n, h1, w1, c1 + 2)", OrderNHWC, im.order)), f""".r;
        gl_FragColor.a = """, texel_fetch(im, change_order("vec4(n, h1, w1, c1 + 3)", OrderNHWC, im.order)), f""".r;
    }}
}}
"""])

    else:
        raise NotImplementedError

    source = code.generate()
    return [Kernel(
        source,
        code.name,
        code.samplers,
        code.uniforms,
        col
    )]