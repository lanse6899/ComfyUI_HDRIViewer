"""
Panorama Viewer Node for ComfyUI
Provides interactive 3D-like panorama viewing with equirectangular projection.
"""

import base64
import io
from typing import Optional, Tuple

import numpy as np
import torch
from PIL import Image


class PanoramaViewer:
    """
    A ComfyUI node for interactive 360-degree panorama image viewing.
    Provides 3D-like controls to explore panoramic images.
    """

    CATEGORY = "🔵BB HDRI viewer"
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "process_image"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {}),
                "view_width": ("INT", {
                    "default": 1280,
                    "min": 320,
                    "max": 3840,
                    "step": 1,
                    "label": "View Width"
                }),
                "view_height": ("INT", {
                    "default": 720,
                    "min": 240,
                    "max": 2160,
                    "step": 1,
                    "label": "View Height"
                }),
                "fov": ("INT", {
                    "default": 75,
                    "min": 30,
                    "max": 120,
                    "step": 1,
                    "label": "FOV (Field of View)"
                }),
                "auto_rotate": ("BOOLEAN", {
                    "default": False,
                    "label": "Auto Rotate"
                }),
                "rotation_speed": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.1,
                    "max": 3.0,
                    "step": 0.1,
                    "label": "Rotation Speed"
                }),
                "projection_mode": (["sphere", "equirectangular", "cube"], {
                    "default": "sphere",
                    "label": "Projection Mode"
                }),
            },
            "hidden": {
                "node_id": "INT",
            },
        }

    def process_image(
        self,
        image,
        view_width,
        view_height,
        fov,
        auto_rotate,
        rotation_speed,
        projection_mode,
        node_id=None
    ):
        """
        Pass image through unchanged. Encode preview as base64 data URL in ui.pano_image,
        same contract as ComfyUI_preview360panorama (onExecuted receives pano_image, often
        as char-array — frontend must .join('')).
        """
        pano_image = ""
        try:
            if image is not None and hasattr(image, "__len__") and len(image) > 0:
                img_tensor = image[0] if image.dim() == 4 else image
                max_side = max(view_width, view_height)
                pano_image = self._tensor_to_preview_data_url(img_tensor, max_side) or ""
        except Exception as e:
            print(f"[PanoramaViewer] Error preparing UI data: {e}")

        # Dict form matches ComfyUI output nodes that expose custom UI to the web client
        return {"ui": {"pano_image": pano_image}, "result": ()}

    @staticmethod
    def _tensor_to_preview_data_url(tensor, max_side: int) -> Optional[str]:
        """Match preview360panorama: uint8/float handling, optional downscale, PNG base64."""
        if tensor.dim() == 4:
            tensor = tensor.squeeze(0)
        elif tensor.dim() != 3:
            return None

        image_np = tensor.cpu().numpy()
        if image_np.dtype != np.uint8:
            image_np = (image_np * 255).astype(np.uint8)

        if len(image_np.shape) == 2 or image_np.shape[2] == 1:
            image_np = np.repeat(image_np[..., np.newaxis], 3, axis=2)

        pil_image = Image.fromarray(image_np)
        if max_side > 0 and (
            pil_image.size[0] > max_side or pil_image.size[1] > max_side
        ):
            new_size = tuple(
                int(max_side * x / max(pil_image.size)) for x in pil_image.size
            )
            pil_image = pil_image.resize(new_size, resample=Image.Resampling.LANCZOS)

        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")
        img_str = base64.b64encode(buffer.getvalue()).decode("utf-8")
        return f"data:image/png;base64,{img_str}"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")


class ImageMirror:
    """
    A ComfyUI node for mirroring images horizontally or vertically.
    Useful for correcting panorama orientation or creating mirrored effects.
    """

    CATEGORY = "🔵BB HDRI viewer"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "flip_image"
    CLASS_NAME = "ImageMirror"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {}),
                "mode": (["horizontal", "vertical", "both"], {
                    "default": "horizontal",
                    "label": "Mirror Mode"
                }),
            },
        }

    def flip_image(self, image, mode):
        # ComfyUI IMAGE format: [B, H, W, C]
        # dim 1 = height, dim 2 = width, dim 3 = channels
        if mode == "horizontal":
            flipped = torch.flip(image, dims=[2])  # flip width
        elif mode == "vertical":
            flipped = torch.flip(image, dims=[1])  # flip height
        else:  # both
            flipped = torch.flip(image, dims=[1, 2])
        return (flipped,)


NODE_CLASS_MAPPINGS = {
    "PanoramaViewer": PanoramaViewer,
    "ImageMirror": ImageMirror,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PanoramaViewer": "🔵BB HDRI查看器",
    "ImageMirror": "🔵BB镜像图像",
}
