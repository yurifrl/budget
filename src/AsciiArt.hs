module AsciiArt where

import Control.Monad ( forM_ )
import Data.Function ( on )
import Data.List ( minimumBy )
import Data.Maybe ( fromMaybe )
import Data.Word ( Word8 )
import System.Environment ( getArgs, getProgName )
import Codec.Picture.Types ( convertImage, promoteImage )
import Codec.Picture
  ( DynamicImage
      ( ImageY8
      , ImageYA8
      , ImageRGB8
      , ImageRGBA8
      , ImageYCbCr8
      , ImageCMYK8
      )
  , Image ( imageHeight, imageWidth )
  , PixelRGB8 ( PixelRGB8 )
  , PixelRGBA8 ( PixelRGBA8 )
  , Pixel8
  , pixelAt
  , readImage
  )

-- | Terminal color.
data TermColor =  CGry !Word8 | CS16 !Word8 deriving Show

-- | Convert alpha (transparency) into a character.
alphaToChar :: Word8 -> Char
alphaToChar x
  | x <  80   = ' '
  | otherwise = '█'

-- | Encode the terminal color as an 8-bit number.
encodeTermColor :: TermColor -> Word8
encodeTermColor (CGry x) = 232 + x

-- | Construct the escape code for a terminal color.
escapeTermColor :: Maybe TermColor -> ShowS
escapeTermColor Nothing  = showString "\ESC[0;00m"
escapeTermColor (Just c) = showString "\ESC[38;5;" .
                           shows (encodeTermColor c) .
                           showString "m"

-- | Approximate an RGB color as a grayscale terminal color.
approxGry :: PixelRGB8 -> TermColor
approxGry (PixelRGB8 r g b) = CGry . approx $ fromIntegral z
  where z = sum (fmap fromIntegral [r, g, b + 1]) `div` 3 :: Int
        approx x
          | x <   3   =  0
          | x < 233   = (x - 3) `div` 10
          | otherwise = 23

-- | Approximate an RGB color as a terminal color.
rgbToTermColor :: PixelRGB8 -> TermColor
rgbToTermColor c
  | otherwise = cGry
  where cGry = approxGry c

-- -- | Convert a pixel into a colored text character.
-- pixelToChar :: PixelRGBA8 -> ShowS
-- pixelToChar (PixelRGBA8 r g b a) = escapeTermColor (Just termColor) .
--                                    showChar (alphaToChar a)
--   where termColor = convert $ PixelRGB8 r g b
--         convert   = rgbToTermColor -- use either  rgbToTermColor  or  approxS16

pixelToChar :: Pixel8 -> ShowS
pixelToChar a = showChar (alphaToChar a)

