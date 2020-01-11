module Main where
import Budget

main :: IO ()
main = putStrLn $ show $ Budget.double 4
