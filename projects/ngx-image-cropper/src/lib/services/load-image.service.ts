import { Injectable } from '@angular/core';
import { Dimensions, LoadedImage, ExifTransform } from '../interfaces';
import { getTransformationsFromExifData, supportsAutomaticRotation } from '../utils/exif.utils';
import { ImageCropperState } from '../state/image-cropper-state';

interface LoadImageArrayBuffer {
  originalImage: HTMLImageElement;
  originalArrayBuffer: ArrayBufferLike;
  originalObjectUrl: string;
  originalImageSize?: { width: number; height: number; } | null;
}

@Injectable({providedIn: 'root'})
export class LoadImageService {

  private autoRotateSupported: Promise<boolean> = supportsAutomaticRotation();

  loadNewImage(state: ImageCropperState): Promise<LoadedImage> {
    if (state.imageSource.imageChangedEvent) {
      const target = state.imageSource.imageChangedEvent.target as HTMLInputElement;
      if (!!target.files && target.files.length > 0) {
        return this.loadImageFile(target.files![0], state)};
    } else if (state.imageSource.imageURL) {
      return this.loadImageFromURL(state.imageSource.imageURL, state);
    } else if (state.imageSource.imageBase64) {
      return this.loadBase64Image(state.imageSource.imageBase64, state);
    } else if (state.imageSource.imageFile) {
      return this.loadImageFile(state.imageSource.imageFile, state);
    }
    return Promise.reject(new Error('Invalid image source'));
  }

  async loadImageFile(file: File, state: ImageCropperState): Promise<LoadedImage> {
    const arrayBuffer = await file.arrayBuffer();
    if (state.checkImageType) {
      return await this.checkImageTypeAndLoadImageFromArrayBuffer(arrayBuffer, file.type, state);
    }
    return await this.loadImageFromArrayBuffer(arrayBuffer, state);
  }

  private checkImageTypeAndLoadImageFromArrayBuffer(arrayBuffer: ArrayBufferLike, imageType: string, state: ImageCropperState): Promise<LoadedImage> {
    if (!this.isValidImageType(imageType)) {
      return Promise.reject(new Error('Invalid image type'));
    }
    return this.loadImageFromArrayBuffer(arrayBuffer, state, imageType);
  }

  private isValidImageType(type: string): boolean {
    return /image\/(png|jpg|jpeg|heic|bmp|gif|tiff|svg|webp|x-icon|vnd.microsoft.icon)/.test(type);
  }

  async loadImageFromURL(url: string, state: ImageCropperState): Promise<LoadedImage> {
    const res = await fetch(url);
    const blob = await res.blob();
    const buffer = await blob.arrayBuffer();
    return await this.loadImageFromArrayBuffer(buffer, state, blob.type);
  }

  loadBase64Image(imageBase64: string, state: ImageCropperState): Promise<LoadedImage> {
    const arrayBuffer = this.base64ToArrayBuffer(imageBase64);
    return this.loadImageFromArrayBuffer(arrayBuffer, state);
  }

  private base64ToArrayBuffer(imageBase64: string): ArrayBufferLike {
    imageBase64 = imageBase64.replace(/^data:([^;]+);base64,/gmi, '');
    const binaryString = atob(imageBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private async loadImageFromArrayBuffer(arrayBuffer: ArrayBufferLike, state: ImageCropperState, imageType?: string): Promise<LoadedImage> {
    const res = await new Promise<LoadImageArrayBuffer>(async (resolve, reject) => {
      try {
        const blob = new Blob([arrayBuffer], imageType ? {type: imageType} : undefined);
        const objectUrl = URL.createObjectURL(blob);
        const originalImage = new Image();
        const isSvg = imageType === 'image/svg+xml';
        const originalImageSize = isSvg ? await this.getSvgImageSize(blob) : undefined;
        originalImage.onload = () => resolve({
          originalImage,
          originalImageSize,
          originalObjectUrl: objectUrl,
          originalArrayBuffer: arrayBuffer
        });
        originalImage.onerror = reject;
        originalImage.src = objectUrl;
      } catch (e) {
        reject(e);
      }
    });
    return await this.transformImageFromArrayBuffer(res, state, res.originalImageSize != null);
  }

  private async getSvgImageSize(blob: Blob): Promise<{ width: number; height: number; } | null> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(await blob.text(), 'image/svg+xml');
    const svgElement = doc.querySelector('svg');
    if (!svgElement) {
      throw Error('Failed to parse SVG image');
    }
    const widthAttr = svgElement.getAttribute('width');
    const heightAttr = svgElement.getAttribute('height');
    if (widthAttr && heightAttr) {
      return null;
    }
    const viewBoxAttr = svgElement.getAttribute('viewBox')
      || svgElement.getAttribute('viewbox');
    if (viewBoxAttr) {
      const viewBox = viewBoxAttr.split(' ');
      return {
        width: +viewBox[2],
        height: +viewBox[3]
      };
    }
    throw Error('Failed to load SVG image. SVG must have width + height or viewBox definition.');
  }

  private async transformImageFromArrayBuffer(res: LoadImageArrayBuffer, state: ImageCropperState, forceTransform = false): Promise<LoadedImage> {
    const autoRotate = await this.autoRotateSupported;
    const exifTransform = getTransformationsFromExifData(autoRotate ? -1 : res.originalArrayBuffer);
    if (!res.originalImage || !res.originalImage.complete) {
      return Promise.reject(new Error('No image loaded'));
    }
    const loadedImage = {
      original: {
        objectUrl: res.originalObjectUrl,
        image: res.originalImage,
        size: res.originalImageSize ?? {
          width: res.originalImage.naturalWidth,
          height: res.originalImage.naturalHeight
        }
      },
      exifTransform
    };
    return this.transformLoadedImage(loadedImage, state, forceTransform);
  }

  async transformLoadedImage(loadedImage: Partial<LoadedImage>, state: ImageCropperState, forceTransform = false): Promise<LoadedImage> {
    const canvasRotation = state.canvasRotation + loadedImage.exifTransform!.rotate;
    const originalSize = loadedImage.original!.size;
    if (!forceTransform && canvasRotation === 0 && !loadedImage.exifTransform!.flip && !state.containWithinAspectRatio) {
      return {
        original: {
          objectUrl: loadedImage.original!.objectUrl,
          image: loadedImage.original!.image,
          size: {...originalSize}
        },
        transformed: {
          objectUrl: loadedImage.original!.objectUrl,
          image: loadedImage.original!.image,
          size: {...originalSize}
        },
        exifTransform: loadedImage.exifTransform!
      };
    }

    const transformedSize = this.getTransformedSize(originalSize, loadedImage.exifTransform!, state);
    const canvas = document.createElement('canvas');
    canvas.width = transformedSize.width;
    canvas.height = transformedSize.height;
    const ctx = canvas.getContext('2d');
    ctx?.setTransform(
      loadedImage.exifTransform!.flip ? -1 : 1,
      0,
      0,
      1,
      canvas.width / 2,
      canvas.height / 2
    );
    ctx?.rotate(Math.PI * (canvasRotation / 2));
    ctx?.drawImage(
      loadedImage.original!.image,
      -originalSize.width / 2,
      -originalSize.height / 2
    );
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, state.format));
    if (!blob) {
      throw new Error('Failed to get Blob for transformed image.');
    }
    const objectUrl = URL.createObjectURL(blob);
    const transformedImage = await this.loadImageFromObjectUrl(objectUrl);
    return {
      original: {
        objectUrl: loadedImage.original!.objectUrl,
        image: loadedImage.original!.image,
        size: {...originalSize}
      },
      transformed: {
        objectUrl: objectUrl,
        image: transformedImage,
        size: {
          width: transformedImage.width,
          height: transformedImage.height
        }
      },
      exifTransform: loadedImage.exifTransform!
    };
  }

  private loadImageFromObjectUrl(objectUrl: string): Promise<HTMLImageElement> {
    return new Promise<HTMLImageElement>(((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = objectUrl;
    }));
  }

  private getTransformedSize(
    originalSize: { width: number, height: number },
    exifTransform: ExifTransform,
    state: ImageCropperState
  ): Dimensions {
    const canvasRotation = state.canvasRotation + exifTransform.rotate;
    if (state.containWithinAspectRatio) {
      if (canvasRotation % 2) {
        const minWidthToContain = originalSize.width * state.aspectRatio;
        const minHeightToContain = originalSize.height / state.aspectRatio;
        return {
          width: Math.max(originalSize.height, minWidthToContain),
          height: Math.max(originalSize.width, minHeightToContain)
        };
      } else {
        const minWidthToContain = originalSize.height * state.aspectRatio;
        const minHeightToContain = originalSize.width / state.aspectRatio;
        return {
          width: Math.max(originalSize.width, minWidthToContain),
          height: Math.max(originalSize.height, minHeightToContain)
        };
      }
    }

    if (canvasRotation % 2) {
      return {
        height: originalSize.width,
        width: originalSize.height
      };
    }
    return {
      width: originalSize.width,
      height: originalSize.height
    };
  }
}
