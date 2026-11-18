/**
 * Native photo picker. `allowsEditing` + a 1:1 aspect asks the OS for a square
 * crop UI, but that is not guaranteed (Expo Go on iOS returned the whole
 * 4:3 photo), so the result is always normalized here: center-crop to a square
 * (a no-op when the picker already honoured 1:1) and bound to 512px as JPEG.
 * The web implementation lives in pickAvatarImage.web.ts; both share
 * `squareCropRect` from ./model.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { squareCropRect } from '@/profile/model';

export type PickedImage = { blob: Blob };

/** Open the library picker; null when the user cancels. Throws on failure. */
export async function pickAvatarImage(): Promise<PickedImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
  });
  const asset = result.assets?.[0];
  if (result.canceled || !asset) return null;
  const { originX, originY, side, outSide } = squareCropRect(asset.width, asset.height);
  const square = await ImageManipulator.manipulateAsync(
    asset.uri,
    [{ crop: { originX, originY, width: side, height: side } }, { resize: { width: outSide, height: outSide } }],
    { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
  );
  const blob = await (await fetch(square.uri)).blob();
  return { blob };
}
