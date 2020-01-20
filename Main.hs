{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE DeriveGeneric #-}

module Main where

import Budget

import System.Envy (FromEnv, decodeEnv)
import GHC.Generics (Generic)
import Data.Text (Text)

data NBConfig = NBConfig {
  nbLogin    :: Text,
  nbPassword :: Text
} deriving (Generic, Show)

instance FromEnv NBConfig

main :: IO ()
main = do
  nbConfig <- decodeEnv :: IO (Either String NBConfig)
  case nbConfig of
    Left l -> fail $ show l
    Right r -> run ( Just (nbLogin r) ) ( Just (nbPassword r) )
