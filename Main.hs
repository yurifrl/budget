{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE DeriveGeneric #-}

module Main where

import Budget

import System.Envy (FromEnv, decodeEnv)
import GHC.Generics (Generic)

data NBConfig = NBConfig {
  nbLogin    :: String
, nbPassword :: String
} deriving (Generic, Show)

instance FromEnv NBConfig

main :: IO ()
main = do
  nbConfig <- decodeEnv :: IO (Either String NBConfig)
  case nbConfig of
    Left l -> fail $ show l
    Right r -> print r
